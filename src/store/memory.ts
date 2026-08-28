import type { Clock, RegistryStore, StoredAgent } from "../types.js";

/** Default wall clock implementation for MemoryRegistryStore. */
const systemClock: Clock = { now: () => Date.now() };

/**
 * In-memory implementation of `RegistryStore`.
 * Stores agent instance records in a Javascript Map and uses a background interval timer to prune expired leases.
 */
export class MemoryRegistryStore implements RegistryStore {
  readonly name = "memory";
  readonly #agents = new Map<string, StoredAgent>();
  readonly #clock: Clock;
  readonly #pruneIntervalMs: number;
  #timer?: NodeJS.Timeout;

  /**
   * Create a new MemoryRegistryStore.
   * @param pruneIntervalMs - Interval in milliseconds between expired lease pruning sweeps.
   * @param clock - Optional clock instance for time evaluation.
   */
  constructor(pruneIntervalMs = 5000, clock: Clock = systemClock) {
    this.#pruneIntervalMs = pruneIntervalMs;
    this.#clock = clock;
  }

  /** Start background interval timer for periodic lease pruning sweeps. */
  async start(): Promise<void> {
    if (this.#timer) return;
    this.#timer = setInterval(() => this.prune(), this.#pruneIntervalMs);
    this.#timer.unref();
  }

  /** Stop background pruning sweep timer. */
  async stop(): Promise<void> {
    if (this.#timer) clearInterval(this.#timer);
    this.#timer = undefined;
  }

  /** Check if store is operational (always true for in-memory store). */
  async ready(): Promise<boolean> {
    return true;
  }

  /** Retrieve stored agent instance by ID and instanceId, checking expiration. */
  async get(id: string, instanceId: string): Promise<StoredAgent | undefined> {
    const key = this.key(id, instanceId);
    const agent = this.#agents.get(key);
    if (agent && this.isExpired(agent)) {
      this.#agents.delete(key);
      return undefined;
    }
    return agent === undefined ? undefined : structuredClone(agent);
  }

  /** List all non-expired stored agent instances. */
  async list(): Promise<StoredAgent[]> {
    this.prune();
    return [...this.#agents.values()].map((agent) => structuredClone(agent));
  }

  /** Store or update an agent instance record. */
  async put(agent: StoredAgent): Promise<void> {
    this.#agents.set(this.key(agent.id, agent.instanceId), structuredClone(agent));
  }

  /** Update an agent record without changing its in-memory lease semantics. */
  async update(agent: StoredAgent): Promise<void> {
    this.#agents.set(this.key(agent.id, agent.instanceId), structuredClone(agent));
  }

  /** Renew an existing agent instance lease record. */
  async renew(agent: StoredAgent): Promise<void> {
    this.#agents.set(this.key(agent.id, agent.instanceId), structuredClone(agent));
  }

  /** Delete an agent instance lease record. */
  async delete(agent: StoredAgent): Promise<boolean> {
    return this.#agents.delete(this.key(agent.id, agent.instanceId));
  }

  /** Check if a stored agent record has passed its expiration timestamp. */
  private isExpired(agent: StoredAgent): boolean {
    return Date.parse(agent.expiresAt) <= this.#clock.now();
  }

  /** Generate unique map lookup key for an agent ID and instance ID pair. */
  private key(id: string, instanceId: string): string {
    return instanceId === "default" ? id : `${id}\u0000${instanceId}`;
  }

  /** Sweep and delete all expired agent instances from internal map storage. */
  private prune(): void {
    for (const [id, agent] of this.#agents) {
      if (this.isExpired(agent)) this.#agents.delete(id);
    }
  }
}
