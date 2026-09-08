import type { JWK } from "jose";
import { verifyAgentCardSignature } from "@a2a-js/sdk";
import { RegistryError } from "./errors.js";
import type { AgentCardTrust, JsonObject } from "./types.js";
import type { AgentCard } from "@a2a-js/sdk";

interface ProtectedHeader {
  alg?: string;
  kid?: string;
  typ?: string;
  iss?: string;
  jku?: string;
  [key: string]: unknown;
}

interface CachedJwks {
  expiresAt: number;
  keys: JsonObject[];
}

/** Runtime policy used when validating Agent Card JWS signatures. */
export interface AgentCardTrustOptions {
  /** Reject registrations whose card is not verified when enabled. */
  required: boolean;
  /** Issuers accepted in protected JWS headers. An empty list accepts any issuer. */
  trustedIssuers: string[];
  /** HTTPS origins allowed to serve remote JWK Sets through a protected jku. */
  trustedJkuOrigins: string[];
  /** Locally configured public JWK Set, normally loaded from an environment variable. */
  trustedJwks: JsonObject;
  /** Injectable fetch implementation for deterministic tests. */
  fetch?: typeof globalThis.fetch;
  /** Injectable clock for deterministic tests. */
  now?: () => number;
}

const MAX_REMOTE_JWKS_BYTES = 256 * 1024;
const MAX_REMOTE_KEYS = 64;
const REMOTE_JWKS_TTL_MS = 5 * 60 * 1000;
const MAX_REMOTE_JWKS_CACHE_ENTRIES = 16;

function decodeProtectedHeader(value: unknown): ProtectedHeader {
  if (typeof value !== "string" || value.length === 0) throw new Error("missing protected header");
  const decoded = JSON.parse(Buffer.from(value, "base64url").toString("utf8")) as unknown;
  if (decoded === null || typeof decoded !== "object" || Array.isArray(decoded)) {
    throw new Error("protected header is not an object");
  }
  return decoded as ProtectedHeader;
}

function originOf(value: string): string | undefined {
  try {
    const url = new URL(value);
    if (url.protocol !== "https:" || url.username || url.password || url.hash) return undefined;
    return url.origin;
  } catch {
    return undefined;
  }
}

function keyEntries(jwks: JsonObject): JsonObject[] {
  if (!Array.isArray(jwks.keys)) return [];
  return jwks.keys.filter((value): value is JsonObject =>
    value !== null && typeof value === "object" && !Array.isArray(value),
  ).slice(0, MAX_REMOTE_KEYS);
}

/** Validate and resolve Agent Card signatures without changing the signed card payload. */
export class AgentCardTrustVerifier {
  readonly #options: AgentCardTrustOptions;
  readonly #localKeys: JsonObject[];
  readonly #remoteCache = new Map<string, CachedJwks>();

  constructor(options: AgentCardTrustOptions) {
    this.#options = options;
    this.#localKeys = keyEntries(options.trustedJwks);
  }

  get required(): boolean {
    return this.#options.required;
  }

  /** Verify at least one signature and return metadata separately from the original card. */
  async verify(agentCard: AgentCard): Promise<AgentCardTrust> {
    const signatures = Array.isArray(agentCard.signatures) ? agentCard.signatures : [];
    if (signatures.length === 0) return { status: "unverified", reason: "no_signature" };

    let reason = "signature_invalid";
    for (const signature of signatures) {
      try {
        const header = decodeProtectedHeader(signature.protected);
        if (!header.alg || !header.kid || !header.typ) throw new Error("missing required protected header");
        if (this.#options.trustedIssuers.length > 0 &&
            (typeof header.iss !== "string" || !this.#options.trustedIssuers.includes(header.iss))) {
          reason = "issuer_not_trusted";
          continue;
        }
        const key = await this.#resolveKey(header.kid, header.jku);
        const verifier = verifyAgentCardSignature(async () => key);
        // The SDK canonicalizes a copy and excludes signatures; the caller's card is untouched.
        await verifier({ ...agentCard, signatures: [signature] });
        return {
          status: "verified",
          verifiedAt: new Date((this.#options.now ?? Date.now)()).toISOString(),
          ...(typeof header.iss === "string" ? { issuer: header.iss } : {}),
          keyId: header.kid,
          ...(typeof header.jku === "string" ? { jku: header.jku } : {}),
        };
      } catch (error) {
        if (error instanceof Error && error.message.includes("jku")) reason = "jku_not_allowed";
        else if (error instanceof Error && error.message.includes("key")) reason = "key_not_found";
      }
    }
    return { status: "invalid", reason };
  }

  /** Verify and convert an untrusted result into a registration error when required. */
  async enforce(agentCard: AgentCard): Promise<AgentCardTrust> {
    const result = await this.verify(agentCard);
    if (this.#options.required && result.status !== "verified") {
      throw new RegistryError(422, "agent_card_signature_invalid", "Agent Card signature verification failed", {
        status: result.status,
        reason: result.reason,
      });
    }
    return result;
  }

  async #resolveKey(kid: string, jku: unknown): Promise<JWK> {
    if (jku !== undefined) {
      if (typeof jku !== "string") throw new Error("jku not allowed");
      const origin = originOf(jku);
      if (!origin || !this.#options.trustedJkuOrigins.includes(origin)) throw new Error("jku not allowed");
    }
    const local = this.#localKeys.find((candidate) => candidate.kid === kid);
    if (local) return local as JWK;

    if (jku === undefined) throw new Error("key not found");
    if (typeof jku !== "string") throw new Error("jku not allowed");
    const jwks = await this.#fetchJwks(jku);
    const remote = jwks.find((candidate) => candidate.kid === kid);
    if (!remote) throw new Error("key not found");
    return remote as JWK;
  }

  async #fetchJwks(jku: string): Promise<JsonObject[]> {
    const now = (this.#options.now ?? Date.now)();
    const cached = this.#remoteCache.get(jku);
    if (cached && cached.expiresAt > now) return cached.keys;
    const fetcher = this.#options.fetch ?? globalThis.fetch;
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 5000);
    try {
      const response = await fetcher(jku, { method: "GET", redirect: "error", signal: controller.signal });
      if (!response.ok) throw new Error("jku fetch failed");
      if (!response.body) throw new Error("jku response body missing");
      const reader = response.body.getReader();
      const chunks: Uint8Array[] = [];
      let bytes = 0;
      try {
        while (true) {
          const { done, value } = await reader.read();
          if (done) break;
          bytes += value.byteLength;
          if (bytes > MAX_REMOTE_JWKS_BYTES) {
            controller.abort();
            await reader.cancel().catch(() => undefined);
            throw new Error("jku response too large");
          }
          chunks.push(value);
        }
      } finally {
        reader.releaseLock();
      }
      const body = Buffer.concat(chunks, bytes).toString("utf8");
      const parsed = JSON.parse(body) as unknown;
      if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) throw new Error("invalid jwks");
      const keys = keyEntries(parsed as JsonObject);
      if (keys.length === 0) throw new Error("invalid jwks");
      if (this.#remoteCache.size >= MAX_REMOTE_JWKS_CACHE_ENTRIES) {
        const first = this.#remoteCache.keys().next().value;
        if (typeof first === "string") this.#remoteCache.delete(first);
      }
      this.#remoteCache.set(jku, { expiresAt: now + REMOTE_JWKS_TTL_MS, keys });
      return keys;
    } finally {
      clearTimeout(timer);
    }
  }
}
