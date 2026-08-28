#!/usr/bin/env node

import { createRequire } from "node:module";
import { realpathSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { resolve } from "node:path";
import { createRegistryHttpServer } from "./http.js";
import { loadConfig, type RegistryConfig, type RegistryConfigOverrides } from "./config.js";
import { RegistryError } from "./errors.js";
import { createLogger, isLogLevel, LOG_LEVELS, type Logger } from "./logger.js";
import { RegistryService } from "./service.js";
import { EtcdRegistryStore } from "./store/etcd.js";
import { MemoryRegistryStore } from "./store/memory.js";
import type { Server } from "node:http";

const require = createRequire(import.meta.url);
const packageMetadata = require("../package.json") as { version?: unknown };

/** Package version string extracted from package.json. */
export const CLI_VERSION = typeof packageMetadata.version === "string" ? packageMetadata.version : "0.0.0";

/** Custom Error thrown when CLI arguments or env file parsing fail. */
export class CliUsageError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "CliUsageError";
  }
}

/** Options parsed from command-line arguments. */
export interface CliOptions {
  /** Flag indicating if help message was requested. */
  help: boolean;
  /** Flag indicating if version string was requested. */
  version: boolean;
  /** Optional path to a dotenv environment file. */
  envFile?: string;
  /** Explicit configuration overrides from CLI flags. */
  overrides: RegistryConfigOverrides;
}

/** Usage help documentation string. */
const HELP = `A2A Registry Server ${CLI_VERSION}

Usage:
  a2a-registry [options]

Options:
  -h, --help                       Show this help message
  -v, --version                    Print the server version
      --env-file <path>            Load environment variables from a file
  -H, --host <address>             Listen address (REGISTRY_HOST)
  -p, --port <number>              Listen port, 0 chooses a free port (REGISTRY_PORT)
      --public-url <url>           Public base URL (REGISTRY_PUBLIC_URL)
      --store <memory|etcd>        Storage backend (REGISTRY_STORE)
      --log-level <level>          Log level: fatal, error, warn, info, debug, trace, silent
      --default-ttl-seconds <n>    Default registration lease TTL
      --min-ttl-seconds <n>        Minimum registration lease TTL
      --max-ttl-seconds <n>        Maximum registration lease TTL
      --prune-interval-ms <n>      Memory-store expiry sweep interval
      --max-body-bytes <n>         Maximum JSON request body size
      --cors-origin <origin>       Access-Control-Allow-Origin value
      --write-token <token>        Bearer token required for new registrations
      --ui                         Serve the built web UI dashboard (REGISTRY_UI)
      --ui-dir <path>              UI build directory (defaults to ui/dist)
      --etcd-endpoint <url>        etcd v3 JSON gateway endpoint
      --etcd-prefix <prefix>       etcd key prefix
      --etcd-username <username>   etcd username
      --etcd-password <password>   etcd password
      --etcd-bearer-token <token>  Pre-issued etcd bearer token

Environment variables are read first; command-line options override them. The
server handles SIGINT and SIGTERM and waits for active HTTP requests to close.
`;

/** Helper to extract string value for a command-line flag. */
function optionValue(args: string[], index: number, option: string, inline: string | undefined): { value: string; index: number } {
  const value = inline ?? args[index + 1];
  if (value === undefined || value.trim() === "") {
    throw new CliUsageError(`${option} requires a value`);
  }
  return { value, index: inline === undefined ? index + 1 : index };
}

/** Helper to parse and validate integer option from CLI flags. */
function integerOption(option: string, raw: string): number {
  const value = Number(raw);
  if (!Number.isSafeInteger(value)) throw new CliUsageError(`${option} must be a safe integer`);
  return value;
}

/** Parse CLI arguments without mutating process state. */
export function parseCliArgs(args: readonly string[]): CliOptions {
  const options: CliOptions = { help: false, version: false, overrides: {} };
  const overrides: RegistryConfigOverrides = options.overrides;

  for (let index = 0; index < args.length; index += 1) {
    const token = args[index];
    if (!token) continue;
    if (token === "--") throw new CliUsageError("Positional arguments are not supported");

    const equals = token.indexOf("=");
    const name = equals >= 0 ? token.slice(0, equals) : token;
    const inline = equals >= 0 ? token.slice(equals + 1) : undefined;

    if (name === "-h" || name === "--help") {
      if (inline !== undefined) throw new CliUsageError(`${name} does not accept a value`);
      options.help = true;
      continue;
    }
    if (name === "-v" || name === "--version") {
      if (inline !== undefined) throw new CliUsageError(`${name} does not accept a value`);
      options.version = true;
      continue;
    }

    const read = (option: string): string => {
      const result = optionValue(args as string[], index, option, inline);
      index = result.index;
      return result.value;
    };
    const readInteger = (option: string): number => integerOption(option, read(option));

    switch (name) {
      case "--env-file":
        options.envFile = read(name);
        break;
      case "-H":
      case "--host":
        overrides.host = read(name);
        break;
      case "-p":
      case "--port":
        overrides.port = readInteger(name);
        break;
      case "--public-url":
        overrides.publicUrl = read(name);
        break;
      case "--store": {
        const value = read(name);
        if (value !== "memory" && value !== "etcd") throw new CliUsageError(`${name} must be memory or etcd`);
        overrides.store = value;
        break;
      }
      case "--log-level": {
        const value = read(name);
        if (!isLogLevel(value)) throw new CliUsageError(`${name} must be one of: ${LOG_LEVELS.join(", ")}`);
        overrides.logLevel = value;
        break;
      }
      case "--default-ttl":
      case "--default-ttl-seconds":
        overrides.defaultTtlSeconds = readInteger(name);
        break;
      case "--min-ttl":
      case "--min-ttl-seconds":
        overrides.minTtlSeconds = readInteger(name);
        break;
      case "--max-ttl":
      case "--max-ttl-seconds":
        overrides.maxTtlSeconds = readInteger(name);
        break;
      case "--prune-interval-ms":
        overrides.pruneIntervalMs = readInteger(name);
        break;
      case "--max-body-bytes":
        overrides.maxBodyBytes = readInteger(name);
        break;
      case "--cors-origin":
        overrides.corsOrigin = read(name);
        break;
      case "--write-token":
        overrides.writeToken = read(name);
        break;
      case "--ui":
        if (inline !== undefined) throw new CliUsageError(`${name} does not accept a value`);
        overrides.ui = true;
        break;
      case "--etcd-endpoint":
        overrides.etcd = { ...overrides.etcd, endpoint: read(name) };
        break;
      case "--etcd-prefix":
        overrides.etcd = { ...overrides.etcd, prefix: read(name) };
        break;
      case "--etcd-username":
        overrides.etcd = { ...overrides.etcd, username: read(name) };
        break;
      case "--etcd-password":
        overrides.etcd = { ...overrides.etcd, password: read(name) };
        break;
      case "--etcd-bearer-token":
        overrides.etcd = { ...overrides.etcd, bearerToken: read(name) };
        break;
      default:
        throw new CliUsageError(`Unknown option '${token}'`);
    }
  }

  return options;
}

/** Load a small dotenv-compatible file without adding a runtime dependency. */
export async function loadEnvironmentFile(path: string): Promise<void> {
  let contents: string;
  try {
    contents = await readFile(resolve(path), "utf8");
  } catch (error) {
    throw new CliUsageError(`Unable to read env file '${path}': ${error instanceof Error ? error.message : String(error)}`);
  }

  for (const [lineNumber, source] of contents.split(/\r?\n/u).entries()) {
    const line = source.trim();
    if (!line || line.startsWith("#")) continue;
    const assignment = /^(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)$/u.exec(line);
    if (!assignment?.[1] || assignment[2] === undefined) {
      throw new CliUsageError(`Invalid env file entry at ${path}:${lineNumber + 1}`);
    }
    let value = assignment[2].trim();
    if ((value.startsWith("\"") && value.endsWith("\"")) || (value.startsWith("'") && value.endsWith("'"))) {
      value = value.slice(1, -1);
    }
    // Keep explicitly supplied process variables authoritative.
    if (process.env[assignment[1]] === undefined) process.env[assignment[1]] = value;
  }
}

/** Active server runtime handle returned by `startRegistryServer`. */
export interface RegistryRuntime {
  /** Resolved configuration used by the running instance. */
  readonly config: RegistryConfig;
  /** Active RegistryService instance. */
  readonly service: RegistryService;
  /** Active HTTP server instance. */
  readonly server: Server;
  /** Structured logger used by this runtime. */
  readonly logger: Logger;
  /** Gracefully stop the HTTP server and storage backend. */
  close(): Promise<void>;
}

/** Helper to bind and start listening on HTTP server port/host. */
function listen(server: Server, config: RegistryConfig): Promise<void> {
  return new Promise((resolveListen, rejectListen) => {
    const onError = (error: Error): void => {
      server.off("listening", onListening);
      rejectListen(error);
    };
    const onListening = (): void => {
      server.off("error", onError);
      resolveListen();
    };
    server.once("error", onError);
    server.once("listening", onListening);
    server.listen(config.port, config.host);
  });
}

/** Helper to gracefully close the HTTP server instance. */
function closeHttpServer(server: Server): Promise<void> {
  if (!server.listening) return Promise.resolve();
  return new Promise((resolveClose, rejectClose) => {
    server.close((error?: Error) => {
      if (error && (error as NodeJS.ErrnoException).code !== "ERR_SERVER_NOT_RUNNING") rejectClose(error);
      else resolveClose();
    });
  });
}

/** Start a registry instance and return a testable runtime handle. */
export async function startRegistryServer(
  config: RegistryConfig = loadConfig(),
  logger: Logger = createLogger(config.logLevel),
): Promise<RegistryRuntime> {
  const store = config.store === "etcd"
    ? new EtcdRegistryStore(config.etcd)
    : new MemoryRegistryStore(config.pruneIntervalMs);
  const service = new RegistryService(store, {
    defaultTtlSeconds: config.defaultTtlSeconds,
    minTtlSeconds: config.minTtlSeconds,
    maxTtlSeconds: config.maxTtlSeconds,
    healthCheckIntervalMs: config.healthCheckIntervalMs,
  });
  await service.start();
  const server = createRegistryHttpServer(service, config, logger);
  try {
    await listen(server, config);
  } catch (error) {
    await service.stop();
    throw error;
  }

  let closed = false;
  return {
    config,
    service,
    server,
    logger,
    async close(): Promise<void> {
      if (closed) return;
      closed = true;
      await closeHttpServer(server);
      await service.stop();
    },
  };
}

/** Helper to resolve bound address string for logging. */
function boundAddress(server: Server, config: RegistryConfig): string {
  const address = server.address();
  if (!address || typeof address === "string") return config.publicUrl;
  const parsed = new URL(config.publicUrl);
  parsed.port = String(address.port);
  // A wildcard bind address is useful in logs when the public URL is the
  // default, while a configured hostname remains the advertised URL.
  if (config.port === 0) {
    const host = address.address.includes(":") ? `[${address.address}]` : address.address;
    parsed.hostname = host.replace(/^\[|\]$/gu, "");
  }
  return parsed.toString().replace(/\/$/u, "");
}

/** Helper to log errors through the structured logger. */
function printError(logger: Logger, error: unknown): void {
  if (error instanceof CliUsageError) {
    logger.error({ event: "process.error", errorType: error.name }, error.message);
  } else if (error instanceof RegistryError) {
    logger.error({ event: "process.error", errorType: error.name, errorCode: error.code }, error.message);
  } else if (error instanceof Error) {
    logger.error({ event: "process.error", err: error }, error.message);
  } else {
    logger.error({ event: "process.error", error }, String(error));
  }
}

/** Main CLI process entry point executing configuration, startup, signal listeners, and graceful shutdown. */
export async function main(argv: readonly string[] = process.argv.slice(2)): Promise<number> {
  let logger = createLogger();
  let options: CliOptions;
  try {
    options = parseCliArgs(argv);
  } catch (error) {
    printError(logger, error);
    console.error("Run 'a2a-registry --help' for usage.");
    return 2;
  }

  if (options.help) {
    console.log(HELP);
    return 0;
  }
  if (options.version) {
    console.log(CLI_VERSION);
    return 0;
  }

  try {
    if (options.envFile) await loadEnvironmentFile(options.envFile);
    const config = loadConfig(process.env, options.overrides);
    logger = createLogger(config.logLevel);
    const runtime = await startRegistryServer(config, logger);
    logger.info({
      event: "server.started",
      address: boundAddress(runtime.server, config),
      publicUrl: config.publicUrl,
      store: runtime.service.storeName,
      ready: await runtime.service.ready(),
    }, "A2A Registry Server started");

    let stopping = false;
    const shutdown = async (signal: string): Promise<void> => {
      if (stopping) return;
      stopping = true;
      logger.info({ event: "server.stopping", signal }, "Shutting down");
      const timeout = setTimeout(() => {
        logger.fatal({ event: "server.shutdown_timeout" }, "Forced shutdown after timeout");
        process.exit(1);
      }, 10_000);
      timeout.unref();
      try {
        await runtime.close();
        process.exitCode = 0;
      } catch (error) {
        printError(logger, error);
        process.exitCode = 1;
      } finally {
        clearTimeout(timeout);
      }
    };
    process.once("SIGINT", () => void shutdown("SIGINT"));
    process.once("SIGTERM", () => void shutdown("SIGTERM"));
    await new Promise<void>((resolveShutdown) => {
      const check = (): void => {
        if (stopping && !runtime.server.listening) resolveShutdown();
        else setTimeout(check, 25).unref();
      };
      check();
    });
    return typeof process.exitCode === "number" ? process.exitCode : 0;
  } catch (error) {
    printError(logger, error);
    return error instanceof RegistryError && error.code === "invalid_configuration" ? 2 : 1;
  }
}

function isDirectExecution(): boolean {
  const entry = process.argv[1];
  if (!entry) return false;
  try {
    return realpathSync(resolve(entry)) === realpathSync(fileURLToPath(import.meta.url));
  } catch {
    return resolve(entry) === fileURLToPath(import.meta.url);
  }
}

if (isDirectExecution()) {
  void main().then((code) => {
    if (code !== 0) process.exitCode = code;
  }).catch((error: unknown) => {
    printError(createLogger(), error);
    process.exitCode = 1;
  });
}
