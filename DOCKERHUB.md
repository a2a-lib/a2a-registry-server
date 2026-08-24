# A2A Registry Server

A lightweight, lease-based registry and discovery server for [A2A](https://a2a-protocol.org/) agents.

The registry stores A2A Agent Cards, supports TTL heartbeats and ownership tokens, provides filtering and pagination, and can use an in-memory or distributed etcd storage backend. The image also includes the optional web dashboard.

## Quick start

Pull and run the latest release:

```bash
docker pull digicrafts/a2a-registry:0.2.5

docker run -d \
  --name a2a-registry \
  --restart unless-stopped \
  -p 3003:3003 \
  -e REGISTRY_STORE=memory \
  digicrafts/a2a-registry:0.2.5
```

Open the dashboard at [http://localhost:3003](http://localhost:3003).

The registry API is available at `http://localhost:3003/v1`.

Check that the container is ready:

```bash
curl http://localhost:3003/health/ready
```

## Configuration

Pass configuration through environment variables. The most commonly used options are:

| Variable | Default | Description |
|---|---:|---|
| `REGISTRY_PORT` | `3003` | HTTP listening port |
| `REGISTRY_PUBLIC_URL` | Local port URL | Public base URL in service metadata |
| `REGISTRY_STORE` | `memory` | Storage backend: `memory` or `etcd` |
| `REGISTRY_WRITE_TOKEN` | Unset | Bearer token required for registrations |
| `REGISTRY_DEFAULT_TTL_SECONDS` | `60` | Default registration lease TTL |
| `REGISTRY_CORS_ORIGIN` | `*` | Allowed CORS origin |
| `REGISTRY_LOG_LEVEL` | `info` | Pino log level |
| `ETCD_ENDPOINT` | `http://localhost:2379` | etcd v3 JSON gateway URL |
| `ETCD_PREFIX` | `/a2a-registry/agents/` | etcd key prefix |

For the complete configuration reference, see the [server README](https://github.com/a2a-lib/a2a-registry-server/blob/main/README.md).

## Protect writes with a bearer token

Set `REGISTRY_WRITE_TOKEN` at runtime. Do not bake secrets into a custom image:

```bash
docker run -d \
  --name a2a-registry \
  --restart unless-stopped \
  -p 3003:3003 \
  -e REGISTRY_STORE=memory \
  -e REGISTRY_WRITE_TOKEN="change-this-token" \
  digicrafts/a2a-registry:0.2.5
```

Clients must then send:

```http
Authorization: Bearer change-this-token
```

## Distributed deployment with etcd

Use etcd when registrations must survive registry restarts or be shared by multiple registry instances. The registry container must be able to resolve the etcd service name on its Docker network:

```bash
docker run -d \
  --name a2a-registry \
  --restart unless-stopped \
  -p 3003:3003 \
  -e REGISTRY_STORE=etcd \
  -e ETCD_ENDPOINT=http://etcd:2379 \
  -e ETCD_PREFIX=/a2a-registry/agents/ \
  -e REGISTRY_WRITE_TOKEN="change-this-token" \
  digicrafts/a2a-registry:0.2.5
```

For production, enable etcd authentication and TLS, use a least-privilege etcd identity, and run an odd-sized etcd cluster.

## Image details

- Image: `digicrafts/a2a-registry`
- Port: `3003`
- Healthcheck: `GET /health/ready`
- Web dashboard: enabled by default in the image
- Runtime: non-root user
- Base image: Node.js 24 LTS on Alpine Linux 3.24
- Architectures: `linux/amd64` and `linux/arm64`

Available tags include:

```text
0.2.5
latest
```

Version tags are recommended for production deployments.

## Links

- [Docker Hub repository](https://hub.docker.com/r/digicrafts/a2a-registry)
- [Source repository](https://github.com/a2a-lib/a2a-registry-server)
- [A2A specification](https://a2a-protocol.org/latest/specification/)
