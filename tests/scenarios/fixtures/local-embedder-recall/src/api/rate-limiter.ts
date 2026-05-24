/**
 * Token-bucket rate limiter implementation.
 * More burst-friendly than fixed-window; tokens refill at a constant rate.
 */

export interface TokenBucketOptions {
  capacity: number;        // maximum tokens in the bucket
  refillRatePerSec: number; // tokens added per second
  initialTokens?: number;  // defaults to capacity
}

export interface BucketState {
  tokens: number;
  lastRefillAt: number;  // epoch ms
}

/** Compute the number of tokens available after elapsed time. */
export function refill(state: BucketState, opts: TokenBucketOptions, now = Date.now()): BucketState {
  const elapsedSec = (now - state.lastRefillAt) / 1000;
  const newTokens = Math.min(opts.capacity, state.tokens + elapsedSec * opts.refillRatePerSec);
  return { tokens: newTokens, lastRefillAt: now };
}

/**
 * Attempt to consume `count` tokens from the bucket.
 * Returns { allowed: true, remaining } on success or { allowed: false, retryAfterMs } on failure.
 */
export function consume(
  state: BucketState,
  opts: TokenBucketOptions,
  count = 1,
  now = Date.now()
): { allowed: boolean; state: BucketState; remaining: number; retryAfterMs: number } {
  const refilled = refill(state, opts, now);
  if (refilled.tokens >= count) {
    const next = { ...refilled, tokens: refilled.tokens - count };
    return { allowed: true, state: next, remaining: Math.floor(next.tokens), retryAfterMs: 0 };
  }
  const shortfall = count - refilled.tokens;
  const retryAfterMs = Math.ceil((shortfall / opts.refillRatePerSec) * 1000);
  return { allowed: false, state: refilled, remaining: 0, retryAfterMs };
}

/**
 * Distributed token-bucket store.
 * In production, replace the Map with Redis HSET operations.
 */
export class TokenBucketStore {
  private _buckets = new Map<string, BucketState>();

  constructor(private opts: TokenBucketOptions) {}

  private getOrInit(key: string): BucketState {
    if (!this._buckets.has(key)) {
      this._buckets.set(key, {
        tokens: this.opts.initialTokens ?? this.opts.capacity,
        lastRefillAt: Date.now(),
      });
    }
    return this._buckets.get(key)!;
  }

  allow(key: string, cost = 1): { allowed: boolean; remaining: number; retryAfterMs: number } {
    const state = this.getOrInit(key);
    const result = consume(state, this.opts, cost);
    this._buckets.set(key, result.state);
    return { allowed: result.allowed, remaining: result.remaining, retryAfterMs: result.retryAfterMs };
  }

  /** Reset a specific bucket (e.g., after an admin override). */
  reset(key: string): void {
    this._buckets.delete(key);
  }
}
