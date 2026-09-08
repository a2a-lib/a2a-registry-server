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
