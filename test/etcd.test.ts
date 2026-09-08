import assert from "node:assert/strict";
import { afterEach, describe, it } from "node:test";
import type { AgentCard } from "@a2a-js/sdk";
import { randomUUID } from "node:crypto";
import { RegistryService } from "../src/service.js";
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
  for (const perAgent of [false, true]) {
    it(`enforces ${perAgent ? "per-agent" : "global"} capacity across etcd replicas`, {
      skip: !process.env.ETCD_TEST_ENDPOINT,
    }, async () => {
      const prefix = `/quota-test/${randomUUID()}/`;
      const stores = Array.from({ length: 3 }, () => new EtcdRegistryStore({
        endpoint: process.env.ETCD_TEST_ENDPOINT!, prefix,
      }));
      const services = stores.map((store) => new RegistryService(store, {
        defaultTtlSeconds: 60, minTtlSeconds: 1, maxTtlSeconds: 3600,
        maxActiveInstances: perAgent ? 0 : 1, maxInstancesPerAgent: perAgent ? 1 : 0,
      }));
      const inputs = services.map((_, index) => ({
        id: perAgent ? "shared" : `agent-${index}`, instanceId: `instance-${index}`,
        endpoint: "https://example.test/a2a", agentCard: agent().agentCard,
      }));
      try {
        const results = await Promise.allSettled(services.map((service, index) => service.register(inputs[index]!)));
        assert.equal(results.filter((result) => result.status === "fulfilled").length, 1);
        for (const result of results) {
          if (result.status === "rejected") assert.equal(result.reason.code, perAgent ? "agent_instance_quota_exceeded" : "registry_instance_quota_exceeded");
        }
        assert.equal((await stores[0]!.list()).length, 1);
        const winner = results.findIndex((result) => result.status === "fulfilled");
        const result = results[winner]!;
        if (result.status !== "fulfilled") throw new Error("No admission succeeded");
        await services[winner]!.register(inputs[winner]!, result.value.leaseToken);
        await services[winner]!.heartbeatInstance(inputs[winner]!.id, inputs[winner]!.instanceId, result.value.leaseToken);
        await services[winner]!.unregisterInstance(inputs[winner]!.id, inputs[winner]!.instanceId, result.value.leaseToken);
        await services[0]!.register(inputs[0]!);
        assert.equal((await stores[0]!.list()).length, 1);
      } finally {
        for (const record of await stores[0]!.list()) await stores[0]!.delete(record);
      }
    });
  }

  it("rechecks capacity after a snapshot conflict and revokes the rejected lease", async () => {
    let reads = 0;
    let transactions = 0;
    let revoked = false;
    globalThis.fetch = async (input, init) => {
      const path = new URL(String(input)).pathname;
      const body = JSON.parse(String(init?.body ?? "{}"));
      if (path === "/v3/lease/grant") return response({ ID: "104" });
      if (path === "/v3/kv/range") {
        reads += 1;
        return response({ header: { revision: reads === 1 ? "9007199254740993" : "9007199254740994" },
          kvs: reads === 1 ? [] : [{ key: Buffer.from("/agents/other").toString("base64"),
            value: Buffer.from(JSON.stringify({ ...agent(), id: "other" })).toString("base64") }],
        });
      }
      if (path === "/v3/kv/txn") {
        transactions += 1;
        assert.deepEqual(body.compare[1], {
          key: Buffer.from("/agents/").toString("base64"), range_end: Buffer.from("/agents0").toString("base64"),
          target: "MOD", result: "LESS", mod_revision: "9007199254740994",
        });
        return response({ succeeded: false });
      }
      if (path === "/v3/lease/revoke") revoked = body.ID === "104";
      return response({});
    };
    const store = new EtcdRegistryStore({ endpoint: "http://etcd:2379", prefix: "/agents/" });
    const record = agent();
    await assert.rejects(() => store.put(record, { maxActiveInstances: 1, maxInstancesPerAgent: 0 }),
      (error: any) => error.code === "registry_instance_quota_exceeded");
    assert.equal(reads, 2);
    assert.equal(transactions, 1);
    assert.equal(revoked, true);
    assert.equal(record.backendLeaseId, undefined);
  });

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
