import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { generateKeyPair, exportJWK } from "jose";
import { generateAgentCardSignature } from "@a2a-js/sdk";
import type { AgentCard } from "@a2a-js/sdk";
import { AgentCardTrustVerifier } from "../src/trust.js";
import { RegistryService } from "../src/service.js";
import { MemoryRegistryStore } from "../src/store/memory.js";

const card = {
  name: "Trusted Agent",
  supportedInterfaces: [{ url: "https://trusted.example/a2a", protocolBinding: "HTTP+JSON", protocolVersion: "1.0" }],
} as unknown as AgentCard;

describe("Agent Card trust policy", () => {
  it("verifies a trusted JWS without changing the signed card", async () => {
    const { privateKey, publicKey } = await generateKeyPair("RS256");
    const publicJwk = await exportJWK(publicKey);
    publicJwk.kid = "registry-key-1";
    const signer = generateAgentCardSignature(privateKey, {
      alg: "RS256",
      kid: "registry-key-1",
      typ: "JOSE",
      iss: "https://issuer.example",
    });
    const signed = await signer(card);
    const original = JSON.stringify(signed);
    const verifier = new AgentCardTrustVerifier({
      required: true,
      trustedIssuers: ["https://issuer.example"],
      trustedJkuOrigins: [],
      trustedJwks: { keys: [publicJwk] },
    });

    const result = await verifier.enforce(signed);

    assert.equal(result.status, "verified");
    assert.equal(result.issuer, "https://issuer.example");
    assert.equal(result.keyId, "registry-key-1");
    assert.equal(JSON.stringify(signed), original);
    assert.equal(signed.signatures?.length, 1);
  });

  it("rejects a signature whose jku origin is not trusted", async () => {
    const { privateKey } = await generateKeyPair("RS256");
    const signer = generateAgentCardSignature(privateKey, {
      alg: "RS256",
      kid: "remote-key",
      typ: "JOSE",
      jku: "https://evil.example/keys.json",
    });
    const signed = await signer(card);
    const verifier = new AgentCardTrustVerifier({
      required: true,
      trustedIssuers: [],
      trustedJkuOrigins: ["https://trusted.example"],
      trustedJwks: {},
    });

    await assert.rejects(() => verifier.enforce(signed), (error: unknown) =>
      error instanceof Error && error.message.includes("signature verification failed"));
  });

  it("cancels oversized JWK streams before consuming the rest and does not cache them", async () => {
    const { privateKey, publicKey } = await generateKeyPair("RS256");
    const jwk = { ...await exportJWK(publicKey), kid: "remote-key" };
    const signed = await generateAgentCardSignature(privateKey, {
      alg: "RS256", kid: "remote-key", typ: "JOSE", jku: "https://trusted.example/keys",
    })(card);
    let pulls = 0;
    let cancelled = false;
    let fetches = 0;
    const verifier = new AgentCardTrustVerifier({
      required: true, trustedIssuers: [], trustedJkuOrigins: ["https://trusted.example"], trustedJwks: {},
      fetch: async () => {
        fetches += 1;
        if (fetches > 1) {
          // Exactly the limit is accepted, including a UTF-8 character split across chunks.
          const json = JSON.stringify({ keys: [jwk], note: "é" });
          const bytes = Buffer.from(json + " ".repeat(256 * 1024 - Buffer.byteLength(json)));
          const split = bytes.indexOf(Buffer.from("é")) + 1;
          return new Response(new ReadableStream({ start(controller) {
            controller.enqueue(bytes.subarray(0, split));
            controller.enqueue(bytes.subarray(split));
            controller.close();
          } }));
        }
        return new Response(new ReadableStream<Uint8Array>({
          pull(controller) { pulls += 1; controller.enqueue(new Uint8Array(64 * 1024)); },
          cancel() { cancelled = true; },
        }, { highWaterMark: 0 }), { headers: { "content-length": "1" } });
      },
    });
    await assert.rejects(() => verifier.enforce(signed), /signature verification failed/);
    assert.equal(cancelled, true);
    assert.equal(pulls, 5);
    assert.equal((await verifier.enforce(signed)).status, "verified");
    assert.equal((await verifier.enforce(signed)).status, "verified");
    assert.equal(fetches, 2);
  });

  it("persists verification status beside the card and enforces required trust", async () => {
    const { privateKey, publicKey } = await generateKeyPair("RS256");
    const publicJwk = await exportJWK(publicKey);
    publicJwk.kid = "service-key";
    const signed = await generateAgentCardSignature(privateKey, {
      alg: "RS256",
      kid: "service-key",
      typ: "JOSE",
      iss: "https://issuer.example",
    })(card);
    const service = new RegistryService(new MemoryRegistryStore(), {
      defaultTtlSeconds: 60,
      minTtlSeconds: 1,
      maxTtlSeconds: 3600,
      trustVerifier: new AgentCardTrustVerifier({
        required: true,
        trustedIssuers: ["https://issuer.example"],
        trustedJkuOrigins: [],
        trustedJwks: { keys: [publicJwk] },
      }),
    });
    try {
      const registration = await service.register({
        id: "trusted-agent",
        endpoint: "https://trusted.example/a2a",
        agentCard: signed,
      });
      assert.equal(registration.agent.agentCardTrust.status, "verified");
      assert.deepEqual(registration.agent.agentCard, signed);
    } finally {
      await service.stop();
    }
  });
});
