# A2A Registry Server

[![GitHub release](https://img.shields.io/github/v/release/a2a-lib/a2a-registry-server)](https://github.com/a2a-lib/a2a-registry-server/releases/latest)
[![GitHub stars](https://img.shields.io/github/stars/a2a-lib/a2a-registry-server)](https://github.com/a2a-lib/a2a-registry-server/stargazers)
[![Docker image version](https://img.shields.io/docker/v/digicrafts/a2a-registry?sort=semver&logo=docker&label=Docker%20image)](https://hub.docker.com/r/digicrafts/a2a-registry/tags)
[![Docker pulls](https://img.shields.io/docker/pulls/digicrafts/a2a-registry?logo=docker&label=Docker%20pulls)](https://hub.docker.com/r/digicrafts/a2a-registry)
[![npm version](https://img.shields.io/npm/v/%40a2a-lib%2Fregistry-server)](https://www.npmjs.com/package/@a2a-lib/registry-server)
[![npm downloads](https://img.shields.io/npm/dm/%40a2a-lib%2Fregistry-server)](https://www.npmjs.com/package/@a2a-lib/registry-server)
[![CI](https://github.com/a2a-lib/a2a-registry-server/actions/workflows/ci.yml/badge.svg?branch=main)](https://github.com/a2a-lib/a2a-registry-server/actions/workflows/ci.yml)

A lease-based registration and discovery service for logical AI agents that publish [A2A Agent Cards](https://a2a-protocol.org/latest/specification/). A logical agent can expose multiple independently leased runtime instances that share one Agent Card. The server also provides ownership tokens, TTL heartbeats, filtering, pagination, caching, metrics, tests, and an optional distributed etcd store.

This project is a registry **for** A2A agents. Its registry REST API is intentionally separate from the A2A task/message protocol. The A2A specification standardizes Agent Cards and describes registries/catalogs as a discovery mechanism, but it does not prescribe one universal registry API.

## Features

- Stores current A2A 1.0 Agent Cards without stripping unknown fields
- Accepts both v1 `supportedInterfaces[].url` and the legacy card `url`
- Lease/heartbeat model inspired by etcd and Consul TTL checks
- Multiple runtime instances per logical agent, with a shared Agent Card
- Per-instance endpoint, metadata, TTL, lease token, heartbeat, and expiry
- Optional global write bearer token controls who may create registrations
- Discovery by skill, skill tag, capability, protocol binding, or agent name
- Cursor pagination, ETags, readiness/liveness probes, Prometheus text metrics
- Optional active HTTP/TCP health checks with passing, warning, and critical states
- Revision-resumable Server-Sent Events watch API for local resolver updates
- In-memory backend for development and an etcd v3 backend for replicated deployments
- Compatibility aliases for the routes and `ttlMs` field in the original PoC
- No web framework; runtime dependencies are the official A2A TypeScript SDK and Pino structured logger

## Quick start

Requirements: Node.js 22 or newer.

Install the package globally via npm:

```bash
npm install -g @a2a-lib/registry-server
```

Start the registry server using the CLI:

```bash
a2a-registry
```

Alternatively, run it directly without global installation using `npx`:

```bash
npx @a2a-lib/registry-server
```

The server starts by default at `http://localhost:3003` using the in-memory store.

### Web dashboard

The React dashboard is maintained as the `ui` Git submodule and can be served on the same port as the registry API:

```bash
git clone --recurse-submodules git@github.com:a2a-lib/a2a-registry-server.git
cd a2a-registry-server
npm ci
npm --prefix ui ci
npm run build:all
node dist/cli.js --ui
```

When working from an existing clone, initialize the dashboard with `git submodule update --init --recursive`. The default build path is `ui/dist`; use `--ui-dir <path>` or `REGISTRY_UI_DIR` for a different static build. If the UI build is missing, dashboard requests return a clear `503` response while API and health endpoints remain available.

### CLI options

The CLI accepts configuration flags (which take precedence over environment variables) as well as dotenv-compatible files:

```bash
# Start with explicit host, port, and store
a2a-registry --host 127.0.0.1 --port 3003 --store memory

# Load configuration from a .env file
a2a-registry --env-file .env

# Serve the built web dashboard with the API
a2a-registry --ui

# Emit only warnings and errors
a2a-registry --log-level warn

# Inspect all available options
a2a-registry --help
```

Use `--help` for all options. `SIGINT` and `SIGTERM` trigger a graceful shutdown that stops accepting connections, waits for active requests, and closes the storage backend.

## Deploying with Docker

The registry server is available as the published Docker Hub image [`digicrafts/a2a-registry`](https://hub.docker.com/repository/docker/digicrafts/a2a-registry). The image includes the API, optional web UI, a non-root runtime user, and a readiness healthcheck on port `3003`.

### Use the published Docker image

Pull a specific release tag for repeatable deployments:

```bash
docker pull digicrafts/a2a-registry:0.3.0
```

Run the registry with the in-memory store:

```bash
docker run -d \
  --name a2a-registry \
  --restart unless-stopped \
  -p 3003:3003 \
  -e REGISTRY_PORT=3003 \
  -e REGISTRY_STORE=memory \
  digicrafts/a2a-registry:0.3.0
```

The `latest` tag is also available, but version tags are recommended for production:

```bash
docker pull digicrafts/a2a-registry:latest
```

To enable a write bearer token, pass it at runtime rather than storing it in the image:

```bash
docker run -d \
  --name a2a-registry \
  --restart unless-stopped \
  -p 3003:3003 \
  -e REGISTRY_PORT=3003 \
  -e REGISTRY_STORE=memory \
  -e REGISTRY_WRITE_TOKEN=my-secret-token \
  digicrafts/a2a-registry:0.3.0
```

For a distributed deployment, use `REGISTRY_STORE=etcd` and configure `ETCD_ENDPOINT`, `ETCD_PREFIX`, and any required etcd credentials. See [Distributed deployment with etcd](#distributed-deployment-with-etcd).

### Build the Docker image locally

You can also build and deploy the registry server as a lightweight container using the included multi-stage `Dockerfile`:

```bash
docker build -t digicrafts/a2a-registry:local .
```

Run the local image:

```bash
docker run -d \
  --name a2a-registry \
  -p 3003:3003 \
  -e REGISTRY_PORT=3003 \
  -e REGISTRY_STORE=memory \
  digicrafts/a2a-registry:local
```

### Publish a Docker image

Log in to Docker Hub and publish both a release tag and `latest`. The following command creates a multi-platform image for Linux AMD64 and ARM64:

```bash
docker login

docker buildx create \
  --name digicrafts-builder \
  --driver docker-container \
  --use

docker buildx inspect --bootstrap

docker buildx build \
  --platform linux/amd64,linux/arm64 \
  --pull \
  -t digicrafts/a2a-registry:0.3.0 \
  -t digicrafts/a2a-registry:latest \
  --push \
  .
```

If you only need one architecture, use `docker build` followed by `docker push` instead. The Docker daemon must be running before building or running containers.

### Container health check

The container image includes a built-in healthcheck probing `http://127.0.0.1:3003/health/ready`. You can check container status and logs:

```bash
docker ps --filter "name=a2a-registry"
docker logs a2a-registry
```

## Registering and discovering agents

Register an agent:

```bash
curl -i http://localhost:3003/v1/agents \
  -H 'Content-Type: application/json' \
  -d '{
    "id": "weather-eu-1",
    "ttlSeconds": 60,
    "healthCheck": { "protocol": "http", "path": "/health", "intervalSeconds": 10 },
    "metadata": { "region": "eu-west" },
    "agentCard": {
      "name": "Weather Agent",
      "description": "Returns local forecasts",
      "version": "1.0.0",
      "supportedInterfaces": [{
        "url": "https://weather.example/a2a",
        "protocolBinding": "HTTP+JSON",
        "protocolVersion": "1.0"
      }],
      "capabilities": { "streaming": true },
      "defaultInputModes": ["text/plain"],
      "defaultOutputModes": ["application/json"],
      "skills": [{
        "id": "forecast",
        "name": "Weather forecast",
        "description": "Forecast by location",
        "tags": ["weather"]
      }]
    }
  }'
```

The create response contains the server-assigned `instance.instanceId` and a `leaseToken`. Save the lease token securely: it is returned once and is required to update, renew, or remove the registration.

```bash
export AGENT_LEASE_TOKEN='<value from registration response>'

curl -X POST http://localhost:3003/v1/agents/weather-eu-1/heartbeat \
  -H "X-Registry-Lease-Token: $AGENT_LEASE_TOKEN"

curl 'http://localhost:3003/v1/agents?skill=forecast&capability=streaming&tag=weather'

curl -X DELETE http://localhost:3003/v1/agents/weather-eu-1 \
  -H "X-Registry-Lease-Token: $AGENT_LEASE_TOKEN"
```

Send a heartbeat well before `ttlSeconds` elapses—normally every one-third of the TTL, with jitter and retry backoff. Registrations that omit `instanceId` receive a unique UUID from the server. The returned `instance.instanceId` can be used with the instance-specific routes; the legacy agent-level heartbeat and unregister routes continue to work for a sole instance or when the lease token identifies the instance.

## Multiple instances

Register named instances with the same logical agent ID and exactly the same Agent Card. Put the instance-specific URL in `endpoint`; the shared card may advertise a stable load-balancer URL while discovery clients can select from `agent.instances` directly.

```bash
curl -i http://localhost:3003/v1/agents/weather/instances \
  -H 'Content-Type: application/json' \
  -d '{
    "instanceId": "eu-west-1a",
    "endpoint": "https://weather-a.example/a2a",
    "ttlSeconds": 60,
    "metadata": { "zone": "eu-west-1a", "weight": "100" },
    "agentCard": { "name": "Weather Agent", "supportedInterfaces": [{ "url": "https://weather.example/a2a" }] }
  }'

curl -i http://localhost:3003/v1/agents/weather/instances \
  -H 'Content-Type: application/json' \
  -d '{
    "instanceId": "eu-west-1b",
    "endpoint": "https://weather-b.example/a2a",
    "ttlSeconds": 60,
    "metadata": { "zone": "eu-west-1b", "weight": "100" },
    "agentCard": { "name": "Weather Agent", "supportedInterfaces": [{ "url": "https://weather.example/a2a" }] }
  }'
```

Each response has a different `leaseToken`. Heartbeat an instance at `/v1/agents/{id}/instances/{instanceId}/heartbeat`. Discovery returns one logical agent containing both active records in `instances`; an instance disappears independently when its lease expires. While multiple instances are active, a registration with a different Agent Card is rejected with `409 agent_card_mismatch`.

## API

| Method | Path | Purpose |
|---|---|---|
| `POST` | `/v1/agents` | Register an instance (server-generated UUID when `instanceId` is omitted) |
| `GET` | `/v1/agents` | Discover logical agents and active instances |
| `GET` | `/v1/watch` | Stream revisioned registry snapshots as Server-Sent Events |
| `GET` | `/v1/agents/{id}` | Fetch one logical agent and its active instances |
| `POST` | `/v1/agents/{id}/instances` | Register a named instance |
| `GET` | `/v1/agents/{id}/instances` | List active instances |
| `PUT` | `/v1/agents/{id}/instances/{instanceId}` | Create or replace a named instance |
| `GET` | `/v1/agents/{id}/instances/{instanceId}` | Fetch a named instance |
| `POST` | `/v1/agents/{id}/instances/{instanceId}/heartbeat` | Renew a named instance lease |
| `DELETE` | `/v1/agents/{id}/instances/{instanceId}` | Unregister a named instance |
| `PUT` | `/v1/agents/{id}` | Register an instance, generating its ID when omitted |
| `DELETE` | `/v1/agents/{id}` | Remove the compatibility instance, or the lease-token-owned sole instance |
| `POST` | `/v1/agents/{id}/heartbeat` | Renew the compatibility instance, or the lease-token-owned sole instance |
| `GET` | `/health/live` | Process liveness |
| `GET` | `/health/ready` | Storage readiness |
| `GET` | `/metrics` | Prometheus text metrics |
| `GET` | `/openapi.yaml` | OpenAPI 3.1 document |

Discovery accepts `skill`, `tag`, `capability`, `protocolBinding`, `name`, `limit`, and `cursor`. Pagination and `total` count logical agents, and only logical agents with at least one unexpired instance are returned. The top-level instance fields (`endpoint`, TTL, timestamps, and metadata) remain as a compatibility projection of the first active instance, preferring an explicitly named `default` instance; new clients should use `instances`.

An optional `healthCheck` on each registration enables server-side HTTP or TCP probes. HTTP checks use the registration endpoint unless `path` is supplied; TCP checks connect to the endpoint host and port. Health results are returned as `instance.health` and do not extend the agent-driven TTL lease. The SSE watch endpoint sends an initial snapshot unless `after` (or `Last-Event-ID`) is supplied, then emits a new snapshot whenever the registry revision changes.

PoC-compatible aliases remain available at `/v1/registry`, `/v1/registry/register`, `/v1/registry/agents`, and `/v1/registry/heartbeat`. They use the new ownership rules.

## Configuration

| Variable | Default | Meaning |
|---|---:|---|
| `REGISTRY_HOST` | `0.0.0.0` | Listen address |
| `REGISTRY_PORT` | `3003` | Listen port |
| `REGISTRY_PUBLIC_URL` | local port URL | Base URL used in service metadata |
| `REGISTRY_STORE` | `memory` | `memory` or `etcd` |
| `REGISTRY_LOG_LEVEL` | `info` | Minimum Pino log level: `fatal`, `error`, `warn`, `info`, `debug`, `trace`, or `silent` |
| `REGISTRY_DEFAULT_TTL_SECONDS` | `60` | Lease TTL if omitted |
| `REGISTRY_MIN_TTL_SECONDS` | `10` | Lowest accepted TTL |
| `REGISTRY_MAX_TTL_SECONDS` | `3600` | Highest accepted TTL |
| `REGISTRY_WRITE_TOKEN` | unset | If set, registrations require `Authorization: Bearer …` |
| `REGISTRY_CORS_ORIGIN` | `*` | CORS allow-origin value |
| `REGISTRY_MAX_BODY_BYTES` | `1048576` | Maximum JSON body size |
| `REGISTRY_HEALTH_CHECK_INTERVAL_MS` | `1000` | Scheduler tick for active health checks |
| `REGISTRY_UI` / `REGISTRY_ENABLE_UI` | `false` | Serve the built web dashboard |
| `REGISTRY_UI_DIR` | package `ui/dist` | Static dashboard build directory |
| `ETCD_ENDPOINT` | `http://localhost:2379` | etcd v3 JSON gateway |
| `ETCD_PREFIX` | `/a2a-registry/agents/` | etcd key prefix |
| `ETCD_USERNAME`, `ETCD_PASSWORD` | unset | etcd authentication credentials |
| `ETCD_BEARER_TOKEN` | unset | Pre-issued etcd auth token |

Operational logs are emitted as newline-delimited JSON through Pino. The `--log-level`
CLI option overrides `REGISTRY_LOG_LEVEL`; help and version output remain plain text.

## Distributed deployment with etcd

```bash
docker compose up --build
```

The etcd adapter grants a lease for each runtime instance and attaches that instance's registry key to it. A heartbeat atomically reattaches the key to a new lease and revokes the previous lease. When an instance stops renewing, etcd removes only that instance key even if the registry process that accepted it has failed. All registry replicas must use the same `ETCD_PREFIX` and cluster.

For production, enable etcd authentication and TLS, use a dedicated least-privilege role restricted to the registry prefix, and run an odd-sized etcd cluster. The current adapter accepts an HTTPS endpoint but does not yet expose custom CA/client-certificate file settings.

## Security model

- `REGISTRY_WRITE_TOKEN` is an enrollment control; enable it outside trusted development networks.
- `X-Registry-Lease-Token` proves ownership of one runtime instance. Only its SHA-256 hash is stored.
- Put TLS and an identity-aware proxy/API gateway in front of the server. A shared write token is not a replacement for OAuth2, workload identity, or mTLS.
- Active health checks intentionally fetch or connect to registered endpoints when configured; restrict registration access and network egress to trusted agents to manage SSRF risk.
- Agent Cards are public discovery metadata. Do not place credentials or internal secrets in them.
- Signed Agent Cards are preserved but signature verification and trust policy are deployment-specific and are not performed yet.

## What to add next

1. **Identity and policy:** OIDC/mTLS identities, tenant namespaces, RBAC, admission policy, and audit events. Bind the authenticated identity to the registered agent ID.
2. **Trust:** verify A2A Agent Card JWS signatures, restrict `jku` origins, maintain trusted issuers/keys, and record verification status without modifying the signed card.
3. **Active health checks:** add gRPC health probes and richer check policies; HTTP/TCP probes and passing/warning/critical state reporting are available now and remain separate from TTL heartbeats.
4. **Watch API:** add a native etcd watch/gRPC stream for lower-latency cross-replica delivery; the current SSE endpoint provides revisioned snapshots and works with both memory and etcd stores.
5. **Locality-aware resolution:** add first-class zone/region/weight fields, health-aware selection, and optional client-side round-robin helpers. Until then these values can be carried in per-instance metadata.
6. **Consul adapter:** use Consul sessions/TTL checks and KV/catalog metadata when an organization already operates Consul.
7. **Operations:** OpenTelemetry traces, labeled/rate metrics with bounded cardinality, rate limiting, quotas, backups, chaos tests, and SLO dashboards.
8. **Governance:** moderation/approval workflows, metadata schemas, retention, version compatibility policy, and a documented response to compromised registrations.

## Development

```bash
npm run check
npm test
npm run build
```

The memory store is used in unit/integration tests. Add an etcd container test before changing lease behavior.

## References

- [A2A 1.0 specification](https://a2a-protocol.org/latest/specification/)
- [A2A discovery guide](https://github.com/a2aproject/A2A/blob/main/docs/topics/agent-discovery.md)
- [Official TypeScript SDK](https://github.com/a2aproject/a2a-js)
- [etcd leases and gRPC naming](https://etcd.io/docs/v3.8/dev-guide/grpc_naming/)
- [Consul health checks](https://developer.hashicorp.com/consul/docs/reference/service/health-check)
- [Consul blocking queries](https://developer.hashicorp.com/consul/api-docs/features/blocking)
