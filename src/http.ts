import { timingSafeEqual } from "node:crypto";
import { readFile, realpath, stat } from "node:fs/promises";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { extname, isAbsolute, relative, resolve, sep } from "node:path";
import type { RegistryConfig } from "./config.js";
import { isRegistryError, RegistryError } from "./errors.js";
import { createLogger, type Logger } from "./logger.js";
import { DEFAULT_INSTANCE_ID, RegistryService } from "./service.js";
import { parseAgentQuery, parseRegistration, validateId, validateInstanceId } from "./validation.js";
import { SERVER_VERSION } from "./version.js";

/** Current API version string prefix ("v1"). */
const API_VERSION = "v1";

/** Content types used by Vite output and common dashboard assets. */
const UI_CONTENT_TYPES: Readonly<Record<string, string>> = {
  ".css": "text/css; charset=utf-8",
  ".html": "text/html; charset=utf-8",
  ".ico": "image/x-icon",
  ".jpeg": "image/jpeg",
  ".jpg": "image/jpeg",
  ".js": "text/javascript; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".map": "application/json; charset=utf-8",
  ".png": "image/png",
  ".svg": "image/svg+xml",
  ".webp": "image/webp",
  ".woff": "font/woff",
  ".woff2": "font/woff2",
};

/** Context object for tracking request metadata across lifecycle handlers. */
interface RequestContext {
  /** Unique request correlation ID. */
  requestId: string;
  /** Timestamp when request handling started (ms). */
  startedAt: number;
}

/** In-memory Prometheus metrics counter tracker. */
class Metrics {
  requests = 0;
  errors = 0;
  registrations = 0;
  heartbeats = 0;
  unregistrations = 0;

  /** Render metrics in Prometheus text format (version 0.0.4). */
  render(storeName: string): string {
    return [
      "# HELP a2a_registry_http_requests_total Total HTTP requests.",
      "# TYPE a2a_registry_http_requests_total counter",
      `a2a_registry_http_requests_total ${this.requests}`,
      "# HELP a2a_registry_http_errors_total Total HTTP responses with status >= 400.",
      "# TYPE a2a_registry_http_errors_total counter",
      `a2a_registry_http_errors_total ${this.errors}`,
      "# HELP a2a_registry_registrations_total Successful registrations and updates.",
      "# TYPE a2a_registry_registrations_total counter",
      `a2a_registry_registrations_total ${this.registrations}`,
      "# HELP a2a_registry_heartbeats_total Successful lease renewals.",
      "# TYPE a2a_registry_heartbeats_total counter",
      `a2a_registry_heartbeats_total ${this.heartbeats}`,
      "# HELP a2a_registry_unregistrations_total Successful unregistrations.",
      "# TYPE a2a_registry_unregistrations_total counter",
      `a2a_registry_unregistrations_total ${this.unregistrations}`,
      `a2a_registry_store_info{store="${storeName}"} 1`,
      "",
    ].join("\n");
  }
}

/** Perform constant-time string comparison for secret credentials. */
function constantEquals(actual: string, expected: string): boolean {
  const left = Buffer.from(actual);
  const right = Buffer.from(expected);
  return left.length === right.length && timingSafeEqual(left, right);
}

/** Read and parse JSON request body with maximum byte payload check. */
async function readJson(req: IncomingMessage, maximumBytes: number): Promise<unknown> {
  const chunks: Buffer[] = [];
  let bytes = 0;
  for await (const chunk of req) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    bytes += buffer.length;
    if (bytes > maximumBytes) throw new RegistryError(413, "body_too_large", `Request body exceeds ${maximumBytes} bytes`);
    chunks.push(buffer);
  }
  if (bytes === 0) throw new RegistryError(400, "invalid_json", "A JSON request body is required");
  try {
    return JSON.parse(Buffer.concat(chunks).toString("utf8"));
  } catch {
    throw new RegistryError(400, "invalid_json", "Request body is not valid JSON");
  }
}

/** Set standard response headers including CORS, security parameters, and request ID. */
function setCommonHeaders(res: ServerResponse, config: RegistryConfig, requestId: string): void {
  res.setHeader("Access-Control-Allow-Origin", config.corsOrigin);
  res.setHeader("Access-Control-Allow-Methods", "GET, POST, PUT, DELETE, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Authorization, Content-Type, If-None-Match, X-Registry-Lease-Token, X-Request-Id");
  res.setHeader("Access-Control-Expose-Headers", "ETag, X-Registry-Revision, X-Request-Id");
  res.setHeader("X-Content-Type-Options", "nosniff");
  res.setHeader("X-Request-Id", requestId);
}

/** Send a JSON HTTP response payload. */
function json(res: ServerResponse, status: number, payload: unknown, headers: Record<string, string> = {}): void {
  const body = JSON.stringify(payload);
  res.writeHead(status, {
    "Content-Type": "application/json; charset=utf-8",
    "Content-Length": Buffer.byteLength(body),
    ...headers,
  });
  res.end(body);
}

/** Check that a resolved filesystem path is contained by the UI build root. */
function isWithin(root: string, target: string): boolean {
  const pathFromRoot = relative(root, target);
  return pathFromRoot === "" || (pathFromRoot !== ".." && !pathFromRoot.startsWith(`..${sep}`) && !isAbsolute(pathFromRoot));
}

/** Resolve an existing regular file beneath the UI root, including through safe symlinks. */
async function resolveUiFile(uiDir: string, pathname: string): Promise<string | undefined> {
  let decodedPath: string;
  try {
    decodedPath = decodeURIComponent(pathname);
  } catch {
    throw new RegistryError(400, "invalid_request", "UI path is not valid URL encoding");
  }
  if (decodedPath.includes("\0")) throw new RegistryError(400, "invalid_request", "UI path contains an invalid character");

  let root: string;
  try {
    root = await realpath(uiDir);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
    throw error;
  }

  const candidate = resolve(root, `.${decodedPath.startsWith("/") ? decodedPath : `/${decodedPath}`}`);
  if (!isWithin(root, candidate)) throw new RegistryError(400, "invalid_request", "UI path escapes the configured build directory");

  try {
    const canonical = await realpath(candidate);
    if (!isWithin(root, canonical)) throw new RegistryError(400, "invalid_request", "UI path escapes the configured build directory");
    return (await stat(canonical)).isFile() ? canonical : undefined;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT" || (error as NodeJS.ErrnoException).code === "ENOTDIR") return undefined;
    throw error;
  }
}

/** Serve a dashboard asset or its index.html SPA fallback. */
async function serveUi(req: IncomingMessage, res: ServerResponse, config: RegistryConfig, pathname: string): Promise<void> {
  const requested = await resolveUiFile(config.uiDir, pathname);
  const file = requested ?? await resolveUiFile(config.uiDir, "/index.html");
  if (!file) {
    const body = "Registry UI build not found. Run 'npm run build:ui' or set REGISTRY_UI_DIR/--ui-dir to a built UI directory.\n";
    res.writeHead(503, {
      "Content-Type": "text/plain; charset=utf-8",
      "Content-Length": Buffer.byteLength(body),
      "Cache-Control": "no-store",
    });
    res.end(req.method === "HEAD" ? undefined : body);
    return;
  }

  const body = await readFile(file);
  const isFallback = requested === undefined || extname(file).toLowerCase() === ".html";
  res.writeHead(200, {
    "Content-Type": UI_CONTENT_TYPES[extname(file).toLowerCase()] ?? "application/octet-stream",
    "Content-Length": body.byteLength,
    "Cache-Control": isFallback ? "no-cache" : "public, max-age=3600",
  });
  res.end(req.method === "HEAD" ? undefined : body);
}

/** Paths that must retain API/system 404 semantics instead of falling back to the SPA. */
function isReservedServerPath(pathname: string): boolean {
  return pathname === "/v1" || pathname.startsWith("/v1/") || [
    "/health", "/health/live", "/health/ready", "/metrics", "/openapi.yaml",
  ].includes(pathname);
}

/** Extract Bearer token string from HTTP Authorization header. */
function bearer(req: IncomingMessage): string | undefined {
  const header = req.headers.authorization;
  if (!header?.startsWith("Bearer ")) return undefined;
  return header.slice("Bearer ".length);
}

/** Extract lease token string from X-Registry-Lease-Token header. */
function leaseToken(req: IncomingMessage): string | undefined {
  const value = req.headers["x-registry-lease-token"];
  return Array.isArray(value) ? value[0] : value;
}

/** Extract and decode agent ID from single-agent route paths (e.g. `/v1/agents/:id`). */
function pathId(pathname: string, suffix = ""): string | undefined {
  const expression = suffix
    ? new RegExp(`^/v1/(?:registry/)?agents/([^/]+)/${suffix}$`)
    : /^\/v1\/(?:registry\/)?agents\/([^/]+)$/;
  const match = expression.exec(pathname);
  if (!match?.[1]) return undefined;
  try {
    return validateId(decodeURIComponent(match[1]));
  } catch (error) {
    if (error instanceof URIError) throw new RegistryError(400, "invalid_request", "Agent ID is not valid URL encoding");
    throw error;
  }
}

/** Extract agent ID and instance ID from instance route paths (e.g. `/v1/agents/:id/instances/:instanceId`). */
function instancePath(pathname: string, suffix = ""): { id: string; instanceId: string } | undefined {
  const expression = suffix
    ? new RegExp(`^/v1/agents/([^/]+)/instances/([^/]+)/${suffix}$`)
    : /^\/v1\/agents\/([^/]+)\/instances\/([^/]+)$/;
  const match = expression.exec(pathname);
  if (!match?.[1] || !match[2]) return undefined;
  try {
    return {
      id: validateId(decodeURIComponent(match[1])),
      instanceId: validateInstanceId(decodeURIComponent(match[2])),
    };
  } catch (error) {
    if (error instanceof URIError) throw new RegistryError(400, "invalid_request", "Agent or instance ID is not valid URL encoding");
    throw error;
  }
}

/** Extract agent ID from instance collection route path (`/v1/agents/:id/instances`). */
function instanceCollectionId(pathname: string): string | undefined {
  const match = /^\/v1\/agents\/([^/]+)\/instances$/.exec(pathname);
  if (!match?.[1]) return undefined;
  try {
    return validateId(decodeURIComponent(match[1]));
  } catch (error) {
    if (error instanceof URIError) throw new RegistryError(400, "invalid_request", "Agent ID is not valid URL encoding");
    throw error;
  }
}

/** Check if pathname matches an agent list/discovery route. */
function isListPath(pathname: string): boolean {
  return pathname === "/v1/agents" || pathname === "/v1/registry/agents" || pathname === "/v1/registry";
}

/** Check if pathname matches an agent registration route. */
function isRegisterPath(pathname: string): boolean {
  return pathname === "/v1/agents" || pathname === "/v1/registry/register" || pathname === "/v1/registry";
}

/** Construct relative instance location URL path for HTTP Location headers. */
function instanceLocation(id: string, instanceId: string): string {
  return instanceId === DEFAULT_INSTANCE_ID
    ? `/v1/agents/${encodeURIComponent(id)}`
    : `/v1/agents/${encodeURIComponent(id)}/instances/${encodeURIComponent(instanceId)}`;
}

/** Build the public server metadata payload used by the dashboard and API clients. */
function serverInfo(config: RegistryConfig, service: RegistryService, ready: boolean): Record<string, unknown> {
  const baseUrl = config.publicUrl.replace(/\/$/u, "");
  return {
    name: "A2A Registry Server",
    version: SERVER_VERSION,
    apiVersion: API_VERSION,
    url: baseUrl,
    status: ready ? "ready" : "not_ready",
    store: service.storeName,
    documentation: `${baseUrl}/openapi.yaml`,
    endpoints: {
      metadata: "/v1",
      agents: "/v1/agents",
      liveness: "/health/live",
      readiness: "/health/ready",
      metrics: "/metrics",
      watch: "/v1/watch",
    },
  };
}

/** Stream registry snapshots as Server-Sent Events, resumable by revision. */
async function serveWatch(
  res: ServerResponse,
  service: RegistryService,
  after: number | undefined,
): Promise<void> {
  let lastRevision = after ?? -1;
  let closed = false;
  let keepAlive: NodeJS.Timeout | undefined;
  let poller: NodeJS.Timeout | undefined;
  let resolveClosed!: () => void;
  const closedPromise = new Promise<void>((resolve) => { resolveClosed = resolve; });
  let unsubscribe = (): void => undefined;
  let sendChain = Promise.resolve();

  const close = (): void => {
    if (closed) return;
    closed = true;
    unsubscribe();
    if (keepAlive) clearInterval(keepAlive);
    if (poller) clearInterval(poller);
    resolveClosed();
  };

  const sendSnapshot = async (eventType: string, force = false): Promise<void> => {
    if (closed) return;
    const page = await service.list({ limit: Number.MAX_SAFE_INTEGER });
    if (!force && page.revision <= lastRevision) return;
    lastRevision = page.revision;
    const payload = JSON.stringify({
      type: eventType,
      revision: page.revision,
      agents: page.agents,
      total: page.total,
    });
    res.write(`event: registry\nid: ${page.revision}\ndata: ${payload}\n\n`);
  };

  const scheduleSnapshot = (eventType: string): void => {
    sendChain = sendChain.then(() => sendSnapshot(eventType)).catch(() => close());
  };
  unsubscribe = service.subscribe((event) => scheduleSnapshot(event.type));
  res.once("close", close);
  res.writeHead(200, {
    "Content-Type": "text/event-stream; charset=utf-8",
    "Cache-Control": "no-cache, no-transform",
    Connection: "keep-alive",
    "X-Accel-Buffering": "no",
  });
  res.flushHeaders();
  keepAlive = setInterval(() => {
    if (!closed) res.write(": keep-alive\n\n");
  }, 15_000);
  keepAlive.unref();
  poller = setInterval(() => {
    if (!closed) scheduleSnapshot("changed");
  }, 1_000);
  poller.unref();

  try {
    await sendSnapshot("snapshot", after === undefined);
  } catch {
    close();
    if (!res.writableEnded) res.end();
    return;
  }
  await closedPromise;
}

/**
 * Factory function creating a Node.js HTTP server instance wired to the RegistryService
 * and RegistryConfig. Handles route dispatch, authentication, OpenAPI specs, health checks,
 * metrics, and RFC 7807 error formatting.
 *
 * @param service - Configured RegistryService instance.
 * @param config - Resolved RegistryConfig instance.
 * @param logger - Structured logger to use for request events.
 * @returns Node.js `http.Server` ready to listen.
 */
export function createRegistryHttpServer(
  service: RegistryService,
  config: RegistryConfig,
  logger: Logger = createLogger(config.logLevel),
): Server {
  const metrics = new Metrics();
  return createServer(async (req, res) => {
    const context: RequestContext = {
      requestId: (Array.isArray(req.headers["x-request-id"]) ? req.headers["x-request-id"][0] : req.headers["x-request-id"]) ?? crypto.randomUUID(),
      startedAt: Date.now(),
    };
    const requestLogger = logger.child({ requestId: context.requestId });
    metrics.requests += 1;
    setCommonHeaders(res, config, context.requestId);

    try {
      if (req.method === "OPTIONS") {
        res.writeHead(204);
        res.end();
        return;
      }

      const url = new URL(req.url ?? "/", config.publicUrl);
      const privileged = config.writeToken !== undefined && bearer(req) !== undefined &&
        constantEquals(bearer(req) as string, config.writeToken);

      if (!config.ui && req.method === "GET" && url.pathname === "/") {
        json(res, 200, serverInfo(config, service, await service.ready()), { "Cache-Control": "no-store" });
        return;
      }
      if (req.method === "GET" && url.pathname === "/v1") {
        json(res, 200, serverInfo(config, service, await service.ready()), { "Cache-Control": "no-store" });
        return;
      }
      if (req.method === "GET" && url.pathname === "/openapi.yaml") {
        const body = await readFile(new URL("../openapi.yaml", import.meta.url), "utf8");
        res.writeHead(200, { "Content-Type": "application/yaml; charset=utf-8" });
        res.end(body);
        return;
      }

      if (req.method === "GET" && url.pathname === "/v1/watch") {
        const rawAfter = url.searchParams.get("after") ?? (Array.isArray(req.headers["last-event-id"])
          ? req.headers["last-event-id"][0]
          : req.headers["last-event-id"]);
        const after = rawAfter === undefined ? undefined : Number(rawAfter);
        if (after !== undefined && (!Number.isSafeInteger(after) || after < 0)) {
          throw new RegistryError(400, "invalid_query", "after must be a non-negative integer revision");
        }
        await serveWatch(res, service, after);
        return;
      }

      if (req.method === "GET" && url.pathname === "/health/live") {
        json(res, 200, { status: "ok", service: "a2a-registry" });
        return;
      }
      if (req.method === "GET" && (url.pathname === "/health/ready" || url.pathname === "/health")) {
        const ready = await service.ready();
        json(res, ready ? 200 : 503, { status: ready ? "ready" : "not_ready", store: service.storeName });
        return;
      }
      if (req.method === "GET" && url.pathname === "/metrics") {
        const body = metrics.render(service.storeName);
        res.writeHead(200, { "Content-Type": "text/plain; version=0.0.4; charset=utf-8" });
        res.end(body);
        return;
      }

      if (req.method === "POST" && isRegisterPath(url.pathname)) {
        if (config.writeToken && !privileged) {
          throw new RegistryError(401, "write_auth_required", "A valid bearer token is required to register a new agent");
        }
        const input = parseRegistration(await readJson(req, config.maxBodyBytes));
        const result = await service.register(input, leaseToken(req), privileged);
        metrics.registrations += 1;
        json(res, result.created ? 201 : 200, {
          status: result.created ? "registered" : "updated",
          agent: result.agent,
          instance: result.instance,
          ...(result.leaseToken ? { leaseToken: result.leaseToken } : {}),
        }, {
          Location: instanceLocation(result.agent.id, result.instance.instanceId),
          "Cache-Control": "no-store",
        });
        return;
      }

      const instanceHeartbeat = instancePath(url.pathname, "heartbeat");
      if (req.method === "POST" && instanceHeartbeat) {
        const result = await service.heartbeatInstance(
          instanceHeartbeat.id, instanceHeartbeat.instanceId, leaseToken(req), privileged,
        );
        metrics.heartbeats += 1;
        json(res, 200, { status: "heartbeat_acknowledged", ...result }, { "Cache-Control": "no-store" });
        return;
      }

      const heartbeatId = pathId(url.pathname, "heartbeat");
      if (req.method === "POST" && heartbeatId) {
        const agent = await service.heartbeat(heartbeatId, leaseToken(req), privileged);
        metrics.heartbeats += 1;
        json(res, 200, { status: "heartbeat_acknowledged", agent }, { "Cache-Control": "no-store" });
        return;
      }
      if (req.method === "POST" && url.pathname === "/v1/registry/heartbeat") {
        const body = await readJson(req, config.maxBodyBytes) as { id?: unknown; leaseToken?: unknown };
        const id = validateId(body.id);
        const token = leaseToken(req) ?? (typeof body.leaseToken === "string" ? body.leaseToken : undefined);
        const agent = await service.heartbeat(id, token, privileged);
        metrics.heartbeats += 1;
        json(res, 200, { status: "heartbeat_acknowledged", agent }, { "Cache-Control": "no-store" });
        return;
      }

      if (req.method === "GET" && isListPath(url.pathname)) {
        const page = await service.list(parseAgentQuery(url));
        const etag = `W/\"registry-${page.revision}\"`;
        if (req.headers["if-none-match"] === etag) {
          res.writeHead(304, { ETag: etag, "X-Registry-Revision": String(page.revision) });
          res.end();
          return;
        }
        json(res, 200, page, {
          ETag: etag,
          "X-Registry-Revision": String(page.revision),
          "Cache-Control": "public, max-age=5, must-revalidate",
        });
        return;
      }

      const instancesId = instanceCollectionId(url.pathname);
      if (req.method === "POST" && instancesId) {
        if (config.writeToken && !privileged) {
          throw new RegistryError(401, "write_auth_required", "A valid bearer token is required to register a new agent instance");
        }
        const raw = await readJson(req, config.maxBodyBytes);
        if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
          throw new RegistryError(400, "invalid_request", "Request body must be an object");
        }
        const input = parseRegistration({ ...raw, id: instancesId });
        if (!input.instanceId) throw new RegistryError(400, "invalid_request", "instanceId is required");
        const result = await service.register(input, leaseToken(req), privileged);
        metrics.registrations += 1;
        json(res, result.created ? 201 : 200, {
          status: result.created ? "registered" : "updated",
          agent: result.agent,
          instance: result.instance,
          ...(result.leaseToken ? { leaseToken: result.leaseToken } : {}),
        }, {
          Location: `/v1/agents/${encodeURIComponent(instancesId)}/instances/${encodeURIComponent(result.instance.instanceId)}`,
          "Cache-Control": "no-store",
        });
        return;
      }
      if (req.method === "GET" && instancesId) {
        const instances = await service.listInstances(instancesId);
        json(res, 200, { instances, total: instances.length }, { "Cache-Control": "public, max-age=5, must-revalidate" });
        return;
      }

      const instanceRoute = instancePath(url.pathname);
      if (req.method === "GET" && instanceRoute) {
        const instance = await service.getInstance(instanceRoute.id, instanceRoute.instanceId);
        const etag = `W/\"agent-instance-${instanceRoute.id}-${instance.instanceId}-${instance.revision}\"`;
        if (req.headers["if-none-match"] === etag) {
          res.writeHead(304, { ETag: etag });
          res.end();
          return;
        }
        json(res, 200, { instance }, { ETag: etag, "Cache-Control": "public, max-age=5, must-revalidate" });
        return;
      }
      if (req.method === "PUT" && instanceRoute) {
        const raw = await readJson(req, config.maxBodyBytes);
        if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
          throw new RegistryError(400, "invalid_request", "Request body must be an object");
        }
        const input = parseRegistration({ ...raw, id: instanceRoute.id, instanceId: instanceRoute.instanceId });
        const result = await service.register(
          input, leaseToken(req), privileged, config.writeToken === undefined || privileged,
        );
        metrics.registrations += 1;
        json(res, result.created ? 201 : 200, {
          status: result.created ? "registered" : "updated",
          agent: result.agent,
          instance: result.instance,
          ...(result.leaseToken ? { leaseToken: result.leaseToken } : {}),
        }, { Location: url.pathname, "Cache-Control": "no-store" });
        return;
      }
      if (req.method === "DELETE" && instanceRoute) {
        await service.unregisterInstance(instanceRoute.id, instanceRoute.instanceId, leaseToken(req), privileged);
        metrics.unregistrations += 1;
        res.writeHead(204);
        res.end();
        return;
      }

      const id = pathId(url.pathname);
      if (req.method === "GET" && id) {
        const agent = await service.get(id);
        const etag = `W/\"agent-${agent.id}-${agent.revision}\"`;
        if (req.headers["if-none-match"] === etag) {
          res.writeHead(304, { ETag: etag });
          res.end();
          return;
        }
        json(res, 200, { agent }, { ETag: etag, "Cache-Control": "public, max-age=5, must-revalidate" });
        return;
      }

      if (req.method === "PUT" && id) {
        const raw = await readJson(req, config.maxBodyBytes);
        if (!raw || typeof raw !== "object" || Array.isArray(raw)) throw new RegistryError(400, "invalid_request", "Request body must be an object");
        const input = parseRegistration({ ...raw, id });
        const result = await service.register(input, leaseToken(req), privileged, config.writeToken === undefined || privileged);
        metrics.registrations += 1;
        json(res, result.created ? 201 : 200, {
          status: result.created ? "registered" : "updated",
          agent: result.agent,
          instance: result.instance,
          ...(result.leaseToken ? { leaseToken: result.leaseToken } : {}),
        }, { Location: instanceLocation(id, result.instance.instanceId), "Cache-Control": "no-store" });
        return;
      }

      if (req.method === "DELETE" && id) {
        await service.unregister(id, leaseToken(req), privileged);
        metrics.unregistrations += 1;
        res.writeHead(204);
        res.end();
        return;
      }

      if (config.ui && (req.method === "GET" || req.method === "HEAD") && !isReservedServerPath(url.pathname)) {
        await serveUi(req, res, config, url.pathname);
        return;
      }

      throw new RegistryError(404, "route_not_found", "Route not found");
    } catch (error) {
      metrics.errors += 1;
      const registryError = isRegistryError(error)
        ? error
        : new RegistryError(500, "internal_error", "An unexpected error occurred");
      json(res, registryError.status, {
        type: `https://a2a-registry.dev/problems/${registryError.code}`,
        title: registryError.code,
        status: registryError.status,
        detail: registryError.message,
        requestId: context.requestId,
      }, { "Cache-Control": "no-store" });
      if (!isRegistryError(error)) {
        requestLogger.error({ event: "http.request.error", err: error }, "Unhandled request error");
      }
    } finally {
      requestLogger.info({
        event: "http.request.completed",
        method: req.method,
        path: req.url,
        status: res.statusCode,
        durationMs: Date.now() - context.startedAt,
      }, "Request completed");
    }
  });
}
