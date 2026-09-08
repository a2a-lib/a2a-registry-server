/** A bounded in-memory token bucket keyed by a caller identity. */
export class TokenBucketLimiter {
  readonly #capacity: number;
  readonly #refillPerMs: number;
  readonly #maxEntries: number;
  readonly #buckets = new Map<string, { tokens: number; updatedAt: number }>();

  constructor(requestsPerMinute: number, burst: number, maxEntries = 4096) {
    this.#capacity = burst;
    this.#refillPerMs = requestsPerMinute / 60_000;
    this.#maxEntries = maxEntries;
  }

  /** Consume one token, returning a bounded retry delay when the bucket is empty. */
  consume(key: string, now = Date.now()): { allowed: boolean; retryAfterSeconds: number } {
    let bucket = this.#buckets.get(key);
    if (!bucket) {
      if (this.#buckets.size >= this.#maxEntries) {
        const oldest = this.#buckets.keys().next().value;
        if (typeof oldest === "string") this.#buckets.delete(oldest);
      }
      bucket = { tokens: this.#capacity, updatedAt: now };
      this.#buckets.set(key, bucket);
    }
    bucket.tokens = Math.min(this.#capacity, bucket.tokens + Math.max(0, now - bucket.updatedAt) * this.#refillPerMs);
    bucket.updatedAt = now;
    if (bucket.tokens < 1) {
      return {
        allowed: false,
        retryAfterSeconds: Math.max(1, Math.ceil((1 - bucket.tokens) / this.#refillPerMs / 1000)),
      };
    }
    bucket.tokens -= 1;
    return { allowed: true, retryAfterSeconds: 0 };
  }
}
