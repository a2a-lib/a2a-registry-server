import type { AgentCard } from "@a2a-js/sdk";

/** Generic JSON object type. */
export type JsonObject = Record<string, unknown>;

/** Protocols supported by the built-in active health checker. */
export type HealthCheckProtocol = "http" | "tcp";

/** Optional active probe configuration attached to one runtime instance. */
export interface HealthCheckConfig {
  /** Probe protocol. HTTP checks use the instance endpoint; TCP checks use its host and port. */
  protocol: HealthCheckProtocol;
  /** Optional HTTP path override. */
  path?: string;
  /** Seconds between probes. */
  intervalSeconds?: number;
  /** Per-probe timeout in seconds. */
  timeoutSeconds?: number;
}

/** Latest result from an active health probe. */
export interface HealthStatus {
  /** passing for a successful probe, warning for a non-success HTTP response, or critical on failure. */
  status: "unknown" | "passing" | "warning" | "critical";
  /** ISO 8601 timestamp of the last completed probe. */
  checkedAt?: string;
  /** Probe round-trip time in milliseconds. */
  latencyMs?: number;
  /** Number of consecutive non-passing probes. */
  consecutiveFailures: number;
  /** Optional status code or transport error summary. */
  error?: string;
}

/** One independently leased runtime instance of a logical agent. */
export interface AgentInstance {
  /** Unique identifier of the instance. */
  instanceId: string;
  /** Service endpoint URL for this instance. */
  endpoint: string;
  /** Requested lease Time-To-Live in seconds. */
  ttlSeconds: number;
  /** ISO 8601 timestamp when this instance was first registered. */
  registeredAt: string;
  /** ISO 8601 timestamp when this instance record was last updated. */
  updatedAt: string;
  /** ISO 8601 timestamp when a heartbeat was last received for this instance. */
  lastSeen: string;
  /** ISO 8601 timestamp when this instance lease will expire if not renewed. */
  expiresAt: string;
  /** Key-value metadata associated with this instance. */
  metadata: Record<string, string>;
  /** Optional server-side active health probe configuration. */
  healthCheck?: HealthCheckConfig;
  /** Latest server-side active health probe result. */
  health?: HealthStatus;
  /** Monotonically increasing revision number for state tracking. */
  revision: number;
}

/** Public logical agent returned to discovery clients. */
export interface RegisteredAgent {
  /** Unique logical agent ID. */
  id: string;
  /** Agent display name extracted from the Agent Card. */
  name: string;
  /** Published A2A Agent Card metadata. */
  agentCard: AgentCard;
  /** Active instances contributing to this logical agent. */
  instances: AgentInstance[];
  /** Total number of active instances for this logical agent. */
  instanceCount: number;

  /**
   * Compatibility projection of an explicitly named default (or first) active instance.
   * New clients should use `instances`.
   */
  endpoint: string;
  /** Compatibility TTL in seconds. */
  ttlSeconds: number;
  /** Earliest registration timestamp across active instances. */
  registeredAt: string;
  /** Latest update timestamp across active instances. */
  updatedAt: string;
  /** Latest heartbeat timestamp across active instances. */
  lastSeen: string;
  /** Latest expiration timestamp across active instances. */
  expiresAt: string;
  /** Metadata associated with the primary active instance. */
  metadata: Record<string, string>;
  /** Highest revision number among active instances. */
  revision: number;
}

/** Internal instance record. Internal fields are never serialized by HTTP. */
export interface StoredAgent extends AgentInstance {
  /** Logical agent identifier. */
  id: string;
  /** Agent name. */
  name: string;
  /** Published A2A Agent Card. */
  agentCard: AgentCard;
  /** SHA-256 hash of the secret lease token needed for updates. */
  leaseTokenHash: string;
  /** Optional backend store lease identifier (e.g., etcd lease ID). */
  backendLeaseId?: string;
  /** Optional backend store revision number. */
  backendRevision?: string;
}

/** Input data structure supplied when registering an agent instance. */
export interface RegistrationInput {
  /** Logical agent ID. */
  id: string;
  /** Optional instance identifier (defaults to auto-generated UUID or "default"). */
  instanceId?: string;
  /** Service endpoint URL (can be inferred from agentCard if omitted). */
  endpoint?: string;
  /** Published A2A Agent Card. */
  agentCard: AgentCard;
  /** Requested TTL in seconds for the registration lease. */
  ttlSeconds?: number;
  /** Optional key-value metadata. */
  metadata?: Record<string, string>;
  /** Optional server-side active health probe configuration. */
  healthCheck?: HealthCheckConfig;
}

/** Filter criteria for searching and querying agents in discovery listings. */
export interface AgentQuery {
  /** Filter by skill ID, name, or tag. */
  skill?: string;
  /** Filter by skill tag. */
  tag?: string;
  /** Filter by agent capability (e.g., streaming, push notifications). */
  capability?: string;
  /** Filter by supported protocol binding (e.g., JSON-RPC, HTTP). */
  protocolBinding?: string;
  /** Filter by partial agent name (case-insensitive substring match). */
  name?: string;
  /** Maximum number of agents to return per page. */
  limit: number;
  /** Opaque cursor string for pagination. */
  cursor?: string;
}

/** Paginated response containing registered agents and metadata. */
export interface AgentPage {
  /** Array of matching logical agents. */
  agents: RegisteredAgent[];
  /** Total count of matching agents across all pages. */
  total: number;
  /** Cursor for retrieving the next page of results, if available. */
  nextCursor?: string;
  /** Highest revision number among returned agents. */
  revision: number;
}

/** Lifecycle event types emitted by the registry. */
export type RegistryEventType = "registered" | "updated" | "heartbeat" | "health_changed" | "unregistered" | "expired";

/** Event representing a state change in the agent registry. */
export interface RegistryEvent {
  /** Type of registry event. */
  type: RegistryEventType;
  /** Logical agent ID associated with the event. */
  id: string;
  /** Revision number at the time of the event. */
  revision: number;
  /** ISO 8601 timestamp when the event occurred. */
  timestamp: string;
}

/** Abstract interface for storage backends (e.g. Memory, etcd). */
export interface RegistryStore {
  /** Human-readable identifier for the storage backend implementation. */
  readonly name: string;
  /** Initialize the storage backend connection or timer. */
  start(): Promise<void>;
  /** Gracefully disconnect or clean up storage backend resources. */
  stop(): Promise<void>;
  /** Check if the storage backend is ready and operational. */
  ready(): Promise<boolean>;
  /** Retrieve a specific stored agent instance by agent ID and instance ID. */
  get(id: string, instanceId: string): Promise<StoredAgent | undefined>;
  /** List all active agent instances in the store. */
  list(): Promise<StoredAgent[]>;
  /** Insert or overwrite a stored agent instance record. */
  put(agent: StoredAgent): Promise<void>;
  /** Update a stored record without extending its backend lease. */
  update(agent: StoredAgent): Promise<void>;
  /** Renew the lease for an existing stored agent instance record. */
  renew(agent: StoredAgent): Promise<void>;
  /** Delete a stored agent instance record. */
  delete(agent: StoredAgent): Promise<boolean>;
}

/** Clock interface to decouple time access for deterministic testing. */
export interface Clock {
  /** Returns current timestamp in milliseconds since Unix epoch. */
  now(): number;
}
