import assert from "node:assert/strict";
import { after, before, describe, it } from "node:test";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import type { AgentCard } from "@a2a-js/sdk";
import { createRegistryHttpServer } from "../src/http.js";
import type { RegistryConfig } from "../src/config.js";
import { RegistryService } from "../src/service.js";
import { MemoryRegistryStore } from "../src/store/memory.js";

const card = {
  name: "Weather Agent",
  description: "Returns forecasts",
  version: "1.0.0",
  supportedInterfaces: [{ url: "https://weather.example/a2a", protocolBinding: "HTTP+JSON", protocolVersion: "1.0" }],
  capabilities: { streaming: true, pushNotifications: false },
  defaultInputModes: ["text/plain"],
  defaultOutputModes: ["application/json"],
  skills: [{ id: "forecast", name: "Weather forecast", description: "Forecast by city", tags: ["weather"] }],
} as unknown as AgentCard;

async function readSseEvent(reader: ReadableStreamDefaultReader<Uint8Array>): Promise<Record<string, unknown>> {
  const decoder = new TextDecoder();
  let buffer = "";
  for (;;) {
    const chunk = await reader.read();
    buffer += decoder.decode(chunk.value ?? new Uint8Array(), { stream: !chunk.done });
    const end = buffer.indexOf("\n\n");
    if (end >= 0) {
      const block = buffer.slice(0, end);
      const data = block.split(/\r?\n/u).find((line) => line.startsWith("data:"));
      if (data) return JSON.parse(data.slice("data:".length).trim()) as Record<string, unknown>;
    }
    if (chunk.done) throw new Error("SSE stream ended before an event was received");
  }
}

describe("registry HTTP API", () => {
  const store = new MemoryRegistryStore(1000);
  const service = new RegistryService(store, { defaultTtlSeconds: 60, minTtlSeconds: 1, maxTtlSeconds: 3600 });
  const config: RegistryConfig = {
    host: "127.0.0.1",
    port: 0,
    publicUrl: "http://127.0.0.1",
    store: "memory",
    logLevel: "silent",
    defaultTtlSeconds: 60,
    minTtlSeconds: 1,
    maxTtlSeconds: 3600,
    pruneIntervalMs: 1000,
    maxBodyBytes: 1024 * 1024,
    corsOrigin: "*",
    ui: false,
    uiDir: "/unused",
    etcd: { endpoint: "http://localhost:2379", prefix: "/test/" },
  };
  const server = createRegistryHttpServer(service, config);
  let baseUrl: string;

  before(async () => {
    await service.start();
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  });

  after(async () => {
    await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
    await service.stop();
  });

  it("registers, discovers, renews, and unregisters an Agent Card", async () => {
    const registration = await fetch(`${baseUrl}/v1/agents`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ id: "weather-1", agentCard: card, ttlSeconds: 30, metadata: { region: "eu-west" } }),
    });
    assert.equal(registration.status, 201);
    const registered = await registration.json() as {
      leaseToken: string;
      agent: { endpoint: string };
      instance: { instanceId: string };
    };
    assert.ok(registered.leaseToken);
    assert.equal(registered.agent.endpoint, "https://weather.example/a2a");
    assert.notEqual(registered.instance.instanceId, "default");
    assert.match(registered.instance.instanceId, /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu);

    const discovery = await fetch(`${baseUrl}/v1/agents?skill=forecast&capability=streaming&tag=weather`);
    assert.equal(discovery.status, 200);
    const page = await discovery.json() as { total: number; agents: Array<{ id: string }> };
    assert.equal(page.total, 1);
    assert.equal(page.agents[0]?.id, "weather-1");
    assert.ok(discovery.headers.get("etag"));

    const rejected = await fetch(`${baseUrl}/v1/agents/weather-1/heartbeat`, { method: "POST" });
    assert.equal(rejected.status, 401);

    const heartbeat = await fetch(`${baseUrl}/v1/agents/weather-1/heartbeat`, {
      method: "POST",
      headers: { "x-registry-lease-token": registered.leaseToken },
    });
    assert.equal(heartbeat.status, 200);

    const removed = await fetch(`${baseUrl}/v1/agents/weather-1`, {
      method: "DELETE",
      headers: { "x-registry-lease-token": registered.leaseToken },
    });
    assert.equal(removed.status, 204);
    assert.equal((await fetch(`${baseUrl}/v1/agents/weather-1`)).status, 404);
  });

  it("exposes public server metadata for dashboards", async () => {
    const response = await fetch(`${baseUrl}/v1`);
    assert.equal(response.status, 200);
    const metadata = await response.json() as {
      name: string;
      version: string;
      apiVersion: string;
      url: string;
      status: string;
      store: string;
      documentation: string;
      endpoints: { agents: string };
    };
    assert.equal(metadata.name, "A2A Registry Server");
    assert.match(metadata.version, /^\d+\.\d+\.\d+$/u);
    assert.equal(metadata.apiVersion, "v1");
    assert.equal(metadata.url, "http://127.0.0.1");
    assert.equal(metadata.status, "ready");
    assert.equal(metadata.store, "memory");
    assert.equal(metadata.documentation, "http://127.0.0.1/openapi.yaml");
    assert.equal(metadata.endpoints.agents, "/v1/agents");
  });

  it("supports the PoC registration and heartbeat aliases", async () => {
    const response = await fetch(`${baseUrl}/v1/registry/register`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ id: "legacy-1", endpoint: "https://legacy.example/a2a", agentCard: card, ttlMs: 10_000 }),
    });
    assert.equal(response.status, 201);
    const { leaseToken } = await response.json() as { leaseToken: string };
    const heartbeat = await fetch(`${baseUrl}/v1/registry/heartbeat`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ id: "legacy-1", leaseToken }),
    });
    assert.equal(heartbeat.status, 200);
  });

  it("groups independently leased instances under one logical Agent Card", async () => {
    const firstResponse = await fetch(`${baseUrl}/v1/agents`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        id: "weather-cluster",
        instanceId: "eu-west-1a",
        endpoint: "https://weather-a.example/a2a",
        agentCard: card,
        ttlSeconds: 30,
        metadata: { zone: "eu-west-1a" },
      }),
    });
    assert.equal(firstResponse.status, 201);
    const first = await firstResponse.json() as { leaseToken: string };

    const secondResponse = await fetch(`${baseUrl}/v1/agents/weather-cluster/instances`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        instanceId: "eu-west-1b",
        endpoint: "https://weather-b.example/a2a",
        agentCard: card,
        ttlSeconds: 45,
        metadata: { zone: "eu-west-1b" },
      }),
    });
    assert.equal(secondResponse.status, 201);
    const second = await secondResponse.json() as { leaseToken: string };
    assert.notEqual(first.leaseToken, second.leaseToken);

    const logicalResponse = await fetch(`${baseUrl}/v1/agents/weather-cluster`);
    assert.equal(logicalResponse.status, 200);
    const logical = await logicalResponse.json() as {
      agent: { id: string; instanceCount: number; instances: Array<{ instanceId: string; endpoint: string }> };
    };
    assert.equal(logical.agent.id, "weather-cluster");
    assert.equal(logical.agent.instanceCount, 2);
    assert.deepEqual(logical.agent.instances.map((instance) => instance.instanceId), ["eu-west-1a", "eu-west-1b"]);
    assert.deepEqual(logical.agent.instances.map((instance) => instance.endpoint), [
      "https://weather-a.example/a2a", "https://weather-b.example/a2a",
    ]);

    const instancesResponse = await fetch(`${baseUrl}/v1/agents/weather-cluster/instances`);
    const instances = await instancesResponse.json() as { total: number; instances: Array<{ instanceId: string }> };
    assert.equal(instancesResponse.status, 200);
    assert.equal(instances.total, 2);
    assert.deepEqual(instances.instances.map((instance) => instance.instanceId), ["eu-west-1a", "eu-west-1b"]);

    const instanceResponse = await fetch(`${baseUrl}/v1/agents/weather-cluster/instances/eu-west-1b`);
    assert.equal(instanceResponse.status, 200);
    assert.ok(instanceResponse.headers.get("etag"));

    const updatedResponse = await fetch(`${baseUrl}/v1/agents/weather-cluster/instances/eu-west-1b`, {
      method: "PUT",
      headers: { "content-type": "application/json", "x-registry-lease-token": second.leaseToken },
      body: JSON.stringify({ endpoint: "https://weather-b2.example/a2a", agentCard: card, ttlSeconds: 45 }),
    });
    assert.equal(updatedResponse.status, 200);
    const updated = await updatedResponse.json() as { instance: { endpoint: string }; leaseToken?: string };
    assert.equal(updated.instance.endpoint, "https://weather-b2.example/a2a");
    assert.equal(updated.leaseToken, undefined);

    const wrongLease = await fetch(`${baseUrl}/v1/agents/weather-cluster/instances/eu-west-1b/heartbeat`, {
      method: "POST",
      headers: { "x-registry-lease-token": first.leaseToken },
    });
    assert.equal(wrongLease.status, 401);
    const heartbeat = await fetch(`${baseUrl}/v1/agents/weather-cluster/instances/eu-west-1b/heartbeat`, {
      method: "POST",
      headers: { "x-registry-lease-token": second.leaseToken },
    });
    assert.equal(heartbeat.status, 200);

    const mismatched = await fetch(`${baseUrl}/v1/agents/weather-cluster/instances`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        instanceId: "eu-west-1c",
        endpoint: "https://weather-c.example/a2a",
        agentCard: { ...card, name: "A Different Agent" },
      }),
    });
    assert.equal(mismatched.status, 409);

    for (const [instanceId, token] of [["eu-west-1a", first.leaseToken], ["eu-west-1b", second.leaseToken]]) {
      const removed = await fetch(`${baseUrl}/v1/agents/weather-cluster/instances/${instanceId}`, {
        method: "DELETE",
        headers: { "x-registry-lease-token": token },
      });
      assert.equal(removed.status, 204);
    }
    assert.equal((await fetch(`${baseUrl}/v1/agents/weather-cluster`)).status, 404);
  });

  it("serves its OpenAPI contract and honors discovery ETags", async () => {
    const contract = await fetch(`${baseUrl}/openapi.yaml`);
    assert.equal(contract.status, 200);
    assert.match(await contract.text(), /title: A2A Registry API/);

    const first = await fetch(`${baseUrl}/v1/agents`);
    const etag = first.headers.get("etag");
    assert.ok(etag);
    const cached = await fetch(`${baseUrl}/v1/agents`, { headers: { "if-none-match": etag } });
    assert.equal(cached.status, 304);
  });

  it("streams an initial snapshot and subsequent revision changes", async () => {
    const controller = new AbortController();
    const response = await fetch(`${baseUrl}/v1/watch`, { signal: controller.signal });
    assert.equal(response.status, 200);
    const reader = response.body?.getReader();
    assert.ok(reader);
    const initial = await readSseEvent(reader);
    assert.equal(initial.type, "snapshot");
    const initialRevision = Number(initial.revision);

    const registration = await fetch(`${baseUrl}/v1/agents`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ id: "watched", endpoint: "https://watched.example/a2a", agentCard: card }),
    });
    assert.equal(registration.status, 201);
    const changed = await readSseEvent(reader);
    assert.equal(changed.type, "registered");
    assert.ok(Number(changed.revision) > initialRevision);
    assert.equal((changed.agents as Array<{ id: string }>).some((agent) => agent.id === "watched"), true);
    controller.abort();
    await reader.cancel().catch(() => undefined);
  });
});

describe("active health checks", () => {
  it("records passing and critical HTTP probe results without extending the lease", async () => {
    let status = 200;
    const probe = createServer((_req, res) => {
      res.writeHead(status);
      res.end();
    });
    await new Promise<void>((resolve) => probe.listen(0, "127.0.0.1", resolve));
    const port = (probe.address() as AddressInfo).port;
    const service = new RegistryService(new MemoryRegistryStore(), {
      defaultTtlSeconds: 10,
      minTtlSeconds: 1,
      maxTtlSeconds: 60,
      healthCheckIntervalMs: 10,
    });
    await service.start();
    try {
      const result = await service.register({
        id: "health-checked",
        endpoint: `http://127.0.0.1:${port}/a2a`,
        agentCard: card,
        ttlSeconds: 10,
        healthCheck: { protocol: "http", path: "/health", intervalSeconds: 1, timeoutSeconds: 1 },
      });
      assert.equal(result.instance.health?.status, "unknown");
      const originalExpiry = result.instance.expiresAt;
      let instance = await service.getInstance("health-checked", result.instance.instanceId);
      for (let attempt = 0; attempt < 80 && instance.health?.status !== "passing"; attempt += 1) {
        await new Promise((resolve) => setTimeout(resolve, 20));
        instance = await service.getInstance("health-checked", result.instance.instanceId);
      }
      assert.equal(instance.health?.status, "passing");
      assert.equal(instance.expiresAt, originalExpiry);

      status = 500;
      for (let attempt = 0; attempt < 80 && instance.health?.status !== "critical"; attempt += 1) {
        await new Promise((resolve) => setTimeout(resolve, 20));
        instance = await service.getInstance("health-checked", result.instance.instanceId);
      }
      assert.equal(instance.health?.status, "critical");
      assert.ok((instance.health?.consecutiveFailures ?? 0) > 0);
    } finally {
      await service.stop();
      await new Promise<void>((resolve, reject) => probe.close((error) => error ? reject(error) : resolve()));
    }
  });
});

describe("lease expiry", () => {
  it("removes an agent when its TTL elapses", async () => {
    let now = 1_000_000;
    const clock = { now: () => now };
    const store = new MemoryRegistryStore(1000, clock);
    const service = new RegistryService(store, { defaultTtlSeconds: 10, minTtlSeconds: 1, maxTtlSeconds: 60, clock });
    await service.start();
    await service.register({ id: "expiring", endpoint: "https://example.test/a2a", agentCard: card, ttlSeconds: 2 });
    now += 2001;
    await assert.rejects(() => service.get("expiring"), (error: unknown) =>
      error instanceof Error && error.message.includes("lease expired"));
    await service.stop();
  });

  it("expires instances independently and keeps the logical agent discoverable", async () => {
    let now = 2_000_000;
    const clock = { now: () => now };
    const store = new MemoryRegistryStore(1000, clock);
    const service = new RegistryService(store, { defaultTtlSeconds: 10, minTtlSeconds: 1, maxTtlSeconds: 60, clock });
    await service.start();
    await service.register({
      id: "cluster", instanceId: "short", endpoint: "https://short.example/a2a", agentCard: card, ttlSeconds: 2,
    });
    await service.register({
      id: "cluster", instanceId: "long", endpoint: "https://long.example/a2a", agentCard: card, ttlSeconds: 5,
    });
    now += 2001;
    const agent = await service.get("cluster");
    assert.equal(agent.instanceCount, 1);
    assert.equal(agent.instances[0]?.instanceId, "long");
    await assert.rejects(() => service.getInstance("cluster", "short"), /lease expired/);
    await service.stop();
  });

  it("does not let an unauthenticated caller bypass protected enrollment", async () => {
    const store = new MemoryRegistryStore();
    const service = new RegistryService(store, { defaultTtlSeconds: 10, minTtlSeconds: 1, maxTtlSeconds: 60 });
    await assert.rejects(
      () => service.register({ id: "blocked", endpoint: "https://example.test/a2a", agentCard: card }, undefined, false, false),
      (error: unknown) => error instanceof Error && error.message.includes("bearer token"),
    );
  });
});

describe("instance identifiers", () => {
  it("generates a unique instance ID for each registration that omits it", async () => {
    const store = new MemoryRegistryStore();
    const service = new RegistryService(store, { defaultTtlSeconds: 10, minTtlSeconds: 1, maxTtlSeconds: 60 });
    await service.start();
    const first = await service.register({ id: "generated", endpoint: "https://one.example/a2a", agentCard: card });
    const second = await service.register({ id: "generated", endpoint: "https://two.example/a2a", agentCard: card });

    try {
      assert.notEqual(first.instance.instanceId, "default");
      assert.notEqual(second.instance.instanceId, "default");
      assert.notEqual(first.instance.instanceId, second.instance.instanceId);
      assert.equal((await service.get("generated")).instanceCount, 2);
      await service.unregister("generated", first.leaseToken);
      assert.equal((await service.get("generated")).instanceCount, 1);
      await service.unregister("generated", second.leaseToken);
      await assert.rejects(() => service.get("generated"), /every instance lease expired/);
    } finally {
      await service.unregisterInstance("generated", first.instance.instanceId, first.leaseToken).catch(() => undefined);
      await service.unregisterInstance("generated", second.instance.instanceId, second.leaseToken).catch(() => undefined);
      await service.stop();
    }
  });
});
