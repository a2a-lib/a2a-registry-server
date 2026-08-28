/**
 * @fileoverview Main entry point for the A2A Registry Server package.
 * Exports public API modules including configuration loaders, CLI entry points,
 * error classes, HTTP server creators, service layer implementations, storage backends,
 * and core TypeScript types.
 */

export { loadConfig, type RegistryConfig, type RegistryConfigOverrides } from "./config.js";
export {
  CLI_VERSION,
  CliUsageError,
  loadEnvironmentFile,
  main,
  parseCliArgs,
  startRegistryServer,
  type CliOptions,
  type RegistryRuntime,
} from "./cli.js";
export { RegistryError } from "./errors.js";
export { createRegistryHttpServer } from "./http.js";
export { createLogger, isLogLevel, LOG_LEVELS, type LogLevel, type Logger } from "./logger.js";
export { DEFAULT_INSTANCE_ID, RegistryService } from "./service.js";
export { SERVER_VERSION } from "./version.js";
export { EtcdRegistryStore } from "./store/etcd.js";
export { MemoryRegistryStore } from "./store/memory.js";
export type {
  AgentInstance,
  AgentPage,
  AgentQuery,
  HealthCheckConfig,
  HealthCheckProtocol,
  HealthStatus,
  RegisteredAgent,
  RegistrationInput,
  RegistryStore,
  StoredAgent,
  RegistryEvent,
  RegistryEventType,
} from "./types.js";
