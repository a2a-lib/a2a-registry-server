import assert from "node:assert/strict";
import { afterEach, describe, it } from "node:test";
import type { AgentCard } from "@a2a-js/sdk";
import { EtcdRegistryStore } from "../src/store/etcd.js";
import type { StoredAgent } from "../src/types.js";

const originalFetch = globalThis.fetch;

afterEach(() => {
  globalThis.fetch = originalFetch;
});

function response(payload: unknown): Response {
  return new Response(JSON.stringify(payload), { status: 200, headers: { "content-type": "application/json" } });
}

function agent(): StoredAgent {
  return {
    id: "agent-1",
    instanceId: "default",
    name: "Agent",
    endpoint: "https://example.test/a2a",
    agentCard: { name: "Agent" } as AgentCard,
    ttlSeconds: 60,
    registeredAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-01T00:00:00.000Z",
    lastSeen: "2026-01-01T00:00:00.000Z",
    expiresAt: "2026-01-01T00:01:00.000Z",
    metadata: {},
    revision: 1,
    leaseTokenHash: "hash",
  };
}

describe("etcd store", () => {
  it("uses a version-zero transaction to prevent duplicate ID claims", async () => {
    const requests: Array<{ path: string; body: Record<string, unknown> }> = [];
    globalThis.fetch = async (input, init) => {
      const path = new URL(String(input)).pathname;
      const body = JSON.parse(String(init?.body ?? "{}")) as Record<string, unknown>;
      requests.push({ path, body });
      if (path === "/v3/lease/grant") return response({ ID: "101" });
      if (path === "/v3/kv/txn") return response({
        succeeded: true,
        responses: [{ response_put: { header: { revision: "7" } } }],
      });
      return response({});
    };

    const store = new EtcdRegistryStore({ endpoint: "http://etcd:2379", prefix: "/agents/" });
    const record = agent();
    await store.put(record);

    const transaction = requests.find((request) => request.path === "/v3/kv/txn");
    assert.deepEqual((transaction?.body.compare as unknown[])[0], {
      key: Buffer.from("/agents/agent-1").toString("base64"),
      target: "VERSION",
      version: "0",
      result: "EQUAL",
    });
    assert.equal(record.backendLeaseId, "101");
    assert.equal(record.backendRevision, "7");
  });

  it("stores named instances below an agent-specific key", async () => {
    const requests: Array<{ path: string; body: Record<string, unknown> }> = [];
    globalThis.fetch = async (input, init) => {
      const path = new URL(String(input)).pathname;
      const body = JSON.parse(String(init?.body ?? "{}")) as Record<string, unknown>;
      requests.push({ path, body });
      if (path === "/v3/lease/grant") return response({ ID: "103" });
      if (path === "/v3/kv/txn") return response({ succeeded: true });
      return response({});
    };

    const store = new EtcdRegistryStore({ endpoint: "http://etcd:2379", prefix: "/agents/" });
    const record = agent();
    record.instanceId = "eu-west-2";
    await store.put(record);

    const transaction = requests.find((request) => request.path === "/v3/kv/txn");
    assert.deepEqual((transaction?.body.compare as Array<{ key: string }>)[0]?.key,
      Buffer.from("/agents/agent-1/instances/eu-west-2").toString("base64"));
  });

  it("rejects a failed compare-and-swap and revokes the unused lease", async () => {
    const paths: string[] = [];
    globalThis.fetch = async (input) => {
      const path = new URL(String(input)).pathname;
      paths.push(path);
      if (path === "/v3/lease/grant") return response({ ID: "102" });
      if (path === "/v3/kv/txn") return response({ succeeded: false });
      return response({});
    };

    const store = new EtcdRegistryStore({ endpoint: "http://etcd:2379", prefix: "/agents/" });
    const record = agent();
    record.backendRevision = "6";
    await assert.rejects(() => store.renew(record), /changed concurrently/);
    assert.ok(paths.includes("/v3/lease/revoke"));
  });

  it("updates health state without extending the existing lease", async () => {
    const requests: Array<{ path: string; body: Record<string, unknown> }> = [];
    globalThis.fetch = async (input, init) => {
      const path = new URL(String(input)).pathname;
      const body = JSON.parse(String(init?.body ?? "{}")) as Record<string, unknown>;
      requests.push({ path, body });
      return response({ succeeded: true, responses: [{ response_put: { header: { revision: "8" } } }] });
    };

    const store = new EtcdRegistryStore({ endpoint: "http://etcd:2379", prefix: "/agents/" });
    const record = agent();
    record.backendLeaseId = "101";
    record.backendRevision = "7";
    record.health = { status: "passing", consecutiveFailures: 0 };
    await store.update(record);

    assert.deepEqual(requests.map((request) => request.path), ["/v3/kv/txn"]);
    const transaction = requests[0]!.body;
    assert.equal((transaction.success as Array<{ request_put: { lease: string } }>)[0]?.request_put.lease, "101");
    assert.equal(record.backendRevision, "8");
  });
});
