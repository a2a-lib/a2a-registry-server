import { RegistryError } from "../errors.js";
import type { RegistryStore, StoredAgent } from "../types.js";

/** Configuration options for the etcd storage adapter. */
interface EtcdOptions {
  /** etcd v3 HTTP JSON gateway endpoint (e.g. "http://localhost:2379"). */
  endpoint: string;
  /** Key prefix used to namespace agent data in etcd. */
  prefix: string;
  /** Optional etcd username. */
  username?: string;
  /** Optional etcd password. */
  password?: string;
  /** Optional pre-issued bearer token for etcd HTTP gateway requests. */
  bearerToken?: string;
  /** HTTP request timeout in milliseconds (defaults to 5000ms). */
  requestTimeoutMs?: number;
}

/** Structure of an etcd key-value record returned by the v3 JSON gateway. */
interface EtcdKeyValue {
  /** Base64-encoded key string. */
  key: string;
  /** Base64-encoded value string. */
  value: string;
  /** Modification revision number string. */
  mod_revision?: string;
}

/** Structure of an etcd transaction response. */
interface EtcdTransactionResponse {
  /** Flag indicating whether all transaction compare conditions succeeded. */
  succeeded?: boolean;
  /** Array of response payloads for executed operations. */
  responses?: Array<{ response_put?: { header?: { revision?: string } }; response_delete_range?: { deleted?: string | number } }>;
}

/** Base64 encode a string or Buffer payload for etcd JSON gateway compatibility. */
function base64(value: string | Buffer): string {
  return Buffer.from(value).toString("base64");
}

/** Decode a base64 string returned by the etcd JSON gateway back into a UTF-8 string. */
function unbase64(value: string): string {
  return Buffer.from(value, "base64").toString("utf8");
}

/**
 * Compute the lexicographical upper boundary string for a key prefix range query in etcd.
 * Used for range requests to match all keys starting with `prefix`.
 */
function prefixEnd(prefix: string): string {
  const bytes = Buffer.from(prefix);
  for (let index = bytes.length - 1; index >= 0; index -= 1) {
    const value = bytes[index];
    if (value !== undefined && value < 0xff) {
      bytes[index] = value + 1;
      return base64(bytes.subarray(0, index + 1));
    }
  }
  return base64(Buffer.from([0]));
}

/**
 * etcd v3 JSON gateway-backed store. Agent keys are attached to etcd leases, so
 * expiry is enforced by the cluster and shared by every registry replica.
 */
export class EtcdRegistryStore implements RegistryStore {
  readonly name = "etcd";
  readonly #endpoint: string;
  readonly #prefix: string;
  readonly #username?: string;
  readonly #password?: string;
  readonly #configuredToken?: string;
  readonly #requestTimeoutMs: number;
  #authToken?: string;

  /**
   * Create a new EtcdRegistryStore adapter.
   * @param options - Etcd options object.
   */
  constructor(options: EtcdOptions) {
    this.#endpoint = options.endpoint.replace(/\/$/, "");
    this.#prefix = options.prefix.endsWith("/") ? options.prefix : `${options.prefix}/`;
    this.#username = options.username;
    this.#password = options.password;
    this.#configuredToken = options.bearerToken;
    this.#requestTimeoutMs = options.requestTimeoutMs ?? 5000;
  }

  /** Initialize authentication if username/password were provided and verify readiness. */
  async start(): Promise<void> {
    if (this.#username && this.#password) {
      const response = await this.request<{ token?: string }>("/v3/auth/authenticate", {
        name: this.#username,
        password: this.#password,
      }, false);
      if (!response.token) throw new RegistryError(503, "etcd_auth_failed", "etcd did not return an authentication token");
      this.#authToken = response.token;
    }
    if (!(await this.ready())) throw new RegistryError(503, "store_unavailable", "etcd is not reachable");
  }

  /** Stop the adapter (no-op for etcd HTTP gateway). */
  async stop(): Promise<void> {}

  /** Check if the etcd cluster status endpoint is reachable. */
  async ready(): Promise<boolean> {
    try {
      await this.request("/v3/maintenance/status", {});
      return true;
    } catch {
      return false;
    }
  }

  /** Fetch a stored agent record from etcd by ID and instanceId. */
  async get(id: string, instanceId: string): Promise<StoredAgent | undefined> {
    const response = await this.request<{ kvs?: EtcdKeyValue[] }>("/v3/kv/range", {
      key: base64(this.key(id, instanceId)),
    });
    const entry = response.kvs?.[0];
    return entry ? this.decode(entry) : undefined;
  }

  /** List all active stored agent records within the configured prefix range. */
  async list(): Promise<StoredAgent[]> {
    const response = await this.request<{ kvs?: EtcdKeyValue[] }>("/v3/kv/range", {
      key: base64(this.#prefix),
      range_end: prefixEnd(this.#prefix),
      sort_order: "ASCEND",
      sort_target: "KEY",
    });
    return (response.kvs ?? []).map((entry) => this.decode(entry));
  }

  /** Save or update a stored agent record attached to an etcd lease. */
  async put(agent: StoredAgent): Promise<void> {
    await this.replaceLease(agent);
  }

  /** Update a record while retaining its current etcd lease and expiry. */
  async update(agent: StoredAgent): Promise<void> {
    if (!agent.backendLeaseId || !agent.backendRevision) {
      await this.put(agent);
      return;
    }
    const key = base64(this.key(agent.id, agent.instanceId));
    const response = await this.request<EtcdTransactionResponse>("/v3/kv/txn", {
      compare: [{ key, target: "MOD", mod_revision: agent.backendRevision, result: "EQUAL" }],
      success: [{ request_put: { key, value: base64(JSON.stringify(agent)), lease: agent.backendLeaseId } }],
      failure: [],
    });
    if (!response.succeeded) {
      throw new RegistryError(409, "registration_conflict", "The registration changed concurrently; retry the health update");
    }
    const revision = response.responses?.[0]?.response_put?.header?.revision;
    if (revision) agent.backendRevision = revision;
  }

  /** Renew an agent lease in etcd by replacing the lease with a fresh TTL grant. */
  async renew(agent: StoredAgent): Promise<void> {
    // The JSON gateway's keepalive API is streaming. Replacing the lease keeps
    // this adapter dependency-free and preserves the same expiry semantics.
    await this.replaceLease(agent);
  }

  /** Delete a stored agent record using atomic Compare-And-Swap on mod_revision or version. */
  async delete(agent: StoredAgent): Promise<boolean> {
    const key = base64(this.key(agent.id, agent.instanceId));
    const response = agent.backendRevision
      ? await this.request<EtcdTransactionResponse>("/v3/kv/txn", {
          compare: [{ key, target: "MOD", mod_revision: agent.backendRevision, result: "EQUAL" }],
          success: [{ request_delete_range: { key } }],
          failure: [],
        })
      : await this.request<EtcdTransactionResponse>("/v3/kv/txn", {
          compare: [{ key, target: "VERSION", version: "0", result: "GREATER" }],
          success: [{ request_delete_range: { key } }],
          failure: [],
        });
    if (!response.succeeded) throw new RegistryError(409, "registration_conflict", "The registration changed during deletion; retry with its current lease token");
    if (agent.backendLeaseId) await this.revoke(agent.backendLeaseId).catch(() => undefined);
    return Number(response.responses?.[0]?.response_delete_range?.deleted ?? 1) > 0;
  }

  /** Helper to grant a new etcd lease and update the key atomically inside a transaction. */
  private async replaceLease(agent: StoredAgent): Promise<void> {
    const previousLease = agent.backendLeaseId;
    const grant = await this.request<{ ID?: string | number }>("/v3/lease/grant", { TTL: agent.ttlSeconds });
    if (grant.ID === undefined) throw new RegistryError(503, "etcd_lease_failed", "etcd did not grant a lease");
    const leaseId = String(grant.ID);
    agent.backendLeaseId = leaseId;
    try {
      const key = base64(this.key(agent.id, agent.instanceId));
      const compare = agent.backendRevision
        ? { key, target: "MOD", mod_revision: agent.backendRevision, result: "EQUAL" }
        : { key, target: "VERSION", version: "0", result: "EQUAL" };
      const response = await this.request<EtcdTransactionResponse>("/v3/kv/txn", {
        compare: [compare],
        success: [{ request_put: { key, value: base64(JSON.stringify(agent)), lease: leaseId } }],
        failure: [],
      });
      if (!response.succeeded) {
        throw new RegistryError(409, "registration_conflict", "The registration changed concurrently; fetch it and retry with its current lease token");
      }
      const revision = response.responses?.[0]?.response_put?.header?.revision;
      if (revision) agent.backendRevision = revision;
    } catch (error) {
      await this.revoke(leaseId).catch(() => undefined);
      throw error;
    }
    if (previousLease && previousLease !== leaseId) await this.revoke(previousLease).catch(() => undefined);
  }

  /** Revoke an etcd lease ID. */
  private async revoke(id: string): Promise<void> {
    await this.request("/v3/lease/revoke", { ID: id });
  }

  /** Compute full etcd key for an agent ID and instance ID. */
  private key(id: string, instanceId: string): string {
    const agentKey = `${this.#prefix}${encodeURIComponent(id)}`;
    return instanceId === "default" ? agentKey : `${agentKey}/instances/${encodeURIComponent(instanceId)}`;
  }

  /** Decode an etcd key-value entry into a StoredAgent instance object. */
  private decode(entry: EtcdKeyValue): StoredAgent {
    try {
      const agent = JSON.parse(unbase64(entry.value)) as StoredAgent;
      agent.instanceId ??= "default";
      if (entry.mod_revision) agent.backendRevision = entry.mod_revision;
      return agent;
    } catch (error) {
      throw new RegistryError(503, "invalid_stored_record", "An etcd registry record is not valid JSON", error);
    }
  }

  /** Execute an HTTP fetch request against the etcd v3 JSON gateway with timeout handling. */
  private async request<T = Record<string, unknown>>(path: string, body: unknown, authenticated = true): Promise<T> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.#requestTimeoutMs);
    try {
      const token = this.#configuredToken ?? this.#authToken;
      const response = await fetch(`${this.#endpoint}${path}`, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          ...(authenticated && token ? { authorization: token } : {}),
        },
        body: JSON.stringify(body),
        signal: controller.signal,
      });
      const payload = await response.json().catch(() => ({})) as { error?: string } & T;
      if (!response.ok || payload.error) {
        throw new RegistryError(503, "etcd_request_failed", payload.error ?? `etcd returned HTTP ${response.status}`);
      }
      return payload;
    } catch (error) {
      if (error instanceof RegistryError) throw error;
      throw new RegistryError(503, "etcd_unavailable", "Could not reach etcd", error);
    } finally {
      clearTimeout(timer);
    }
  }
}
