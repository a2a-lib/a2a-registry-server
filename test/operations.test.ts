import assert from "node:assert/strict";
import { createServer, type AddressInfo } from "node:http";
import { describe, it } from "node:test";
import type { AgentCard } from "@a2a-js/sdk";
import type { RegistryConfig } from "../src/config.js";
import { createRegistryHttpServer } from "../src/http.js";
import { TokenBucketLimiter } from "../src/limits.js";
import { RegistryService } from "../src/service.js";
import { MemoryRegistryStore } from "../src/store/memory.js";

const card = {
  name: "Operations Agent",
  supportedInterfaces: [{ url: "https://operations.example/a2a" }],
} as unknown as AgentCard;

describe("operations controls", () => {
  it("enforces a bounded token bucket with a retry delay", () => {
    const limiter = new TokenBucketLimiter(60, 2);
    assert.equal(limiter.consume("127.0.0.1", 0).allowed, true);
    assert.equal(limiter.consume("127.0.0.1", 0).allowed, true);
    const rejected = limiter.consume("127.0.0.1", 0);
    assert.equal(rejected.allowed, false);
    assert.ok(rejected.retryAfterSeconds >= 1);
    assert.equal(limiter.consume("127.0.0.1", 1000).allowed, true);
  });

  it("evicts old caller buckets instead of growing without bound", () => {
    const limiter = new TokenBucketLimiter(60, 1, 2);
    limiter.consume("one", 0);
    limiter.consume("two", 0);
    limiter.consume("three", 0);
    assert.equal(limiter.consume("three", 0).allowed, false);
    assert.equal(limiter.consume("one", 0).allowed, true);
  });

  it("enforces active-instance quotas and exports a secret-free backup", async () => {
    const service = new RegistryService(new MemoryRegistryStore(), {
      defaultTtlSeconds: 60,
      minTtlSeconds: 1,
      maxTtlSeconds: 3600,
      maxActiveInstances: 1,
    });
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
      healthCheckIntervalMs: 1000,
      maxBodyBytes: 1024 * 1024,
      corsOrigin: "*",
      ui: false,
      uiDir: "/unused",
      trust: { required: false, trustedIssuers: [], trustedJkuOrigins: [], trustedJwks: {} },
      backupToken: "backup-secret",
      rateLimitRequestsPerMinute: 100,
      rateLimitBurst: 10,
      maxInstancesPerAgent: 0,
      maxActiveInstances: 1,
      etcd: { endpoint: "http://localhost:2379", prefix: "/test/" },
    };
    const server = createRegistryHttpServer(service, config);
    await service.start();
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
    try {
      const first = await service.register({ id: "operations", endpoint: "https://operations.example/a2a", agentCard: card });
      await assert.rejects(
        () => service.register({ id: "another", endpoint: "https://another.example/a2a", agentCard: card }),
        (error: unknown) => error instanceof Error && error.message.includes("at most 1 active instances"),
      );
      const backup = await fetch(`${baseUrl}/admin/backup`, { headers: { authorization: "Bearer backup-secret" } });
      assert.equal(backup.status, 200);
      const body = await backup.json() as { agents: Array<{ agentCardTrust: { status: string }; instances: unknown[] }> };
      assert.equal(body.agents.length, 1);
      assert.equal(body.agents[0]?.agentCardTrust.status, "unverified");
      assert.equal(JSON.stringify(body).includes("leaseTokenHash"), false);
      const metrics = await (await fetch(`${baseUrl}/metrics`)).text();
      assert.match(metrics, /a2a_registry_http_requests_by_route_total\{[^}]*route="\/admin\/backup"/u);
      await service.unregisterInstance("operations", first.instance.instanceId, first.leaseToken);
    } finally {
      await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
      await service.stop();
    }
  });

  it("survives a transient storage failure during an active health update", async () => {
    class FlakyStore extends MemoryRegistryStore {
      failNextUpdate = true;

      override async update(agent: Parameters<MemoryRegistryStore["update"]>[0]): Promise<void> {
        if (this.failNextUpdate) {
          this.failNextUpdate = false;
          throw new Error("injected update failure");
        }
        await super.update(agent);
      }
    }

    const probe = createServer((_request, response) => { response.writeHead(200); response.end(); });
    await new Promise<void>((resolve) => probe.listen(0, "127.0.0.1", resolve));
    const port = (probe.address() as AddressInfo).port;
    const service = new RegistryService(new FlakyStore(), {
      defaultTtlSeconds: 60,
      minTtlSeconds: 1,
      maxTtlSeconds: 3600,
      healthCheckIntervalMs: 10,
    });
    await service.start();
    try {
      await service.register({
        id: "flaky",
        instanceId: "default",
        endpoint: `http://127.0.0.1:${port}/health`,
        agentCard: card,
        healthCheck: { protocol: "http", intervalSeconds: 1, timeoutSeconds: 1 },
      });
      let instance = await service.getInstance("flaky", "default");
      for (let attempt = 0; attempt < 80 && instance.health?.status !== "passing"; attempt += 1) {
        await new Promise((resolve) => setTimeout(resolve, 20));
        instance = await service.getInstance("flaky", "default");
      }
      assert.equal(instance.health?.status, "passing");
    } finally {
      await service.stop();
      await new Promise<void>((resolve, reject) => probe.close((error) => error ? reject(error) : resolve()));
    }
  });
});
