/**
 * In-process memoization with optional TTL and LRU eviction.
 * Useful for caching expensive computations within a single request or worker.
 */

interface CacheEntry<T> {
  value: T;
  insertedAt: number;
  hits: number;
}

export interface MemoizeOptions {
  ttlMs?: number;       // entry expires after this many milliseconds
  maxSize?: number;     // evict LRU entries when cache exceeds this count
  keyFn?: (...args: unknown[]) => string;  // custom cache key serializer
}

/** Default key: JSON-stringify all arguments. */
function defaultKeyFn(...args: unknown[]): string {
  return JSON.stringify(args);
}

/**
 * Wrap an async function with memoization.
 * Returns a cached result on subsequent calls with identical arguments.
 *
 * @param fn - the function to memoize
 * @param opts - TTL, max size, and key function options
 */
export function memoize<TArgs extends unknown[], TReturn>(
  fn: (...args: TArgs) => Promise<TReturn>,
  opts: MemoizeOptions = {}
): (...args: TArgs) => Promise<TReturn> {
  const cache = new Map<string, CacheEntry<TReturn>>();
  const { ttlMs, maxSize = 256, keyFn = defaultKeyFn } = opts;

  return async (...args: TArgs): Promise<TReturn> => {
    const key = keyFn(...args);
    const now = Date.now();

    const entry = cache.get(key);
    if (entry) {
      if (!ttlMs || now - entry.insertedAt < ttlMs) {
        entry.hits++;
        return entry.value;
      }
      // Expired — fall through to re-compute
      cache.delete(key);
    }

    // Evict least-recently-inserted entry if at capacity
    if (cache.size >= maxSize) {
      const oldest = [...cache.entries()].reduce((a, b) =>
        a[1].insertedAt < b[1].insertedAt ? a : b
      );
      cache.delete(oldest[0]);
    }

    const value = await fn(...args);
    cache.set(key, { value, insertedAt: now, hits: 0 });
    return value;
  };
}

/** Remove a specific key from a memoized function's cache. */
export function invalidate<TArgs extends unknown[]>(
  memoized: { cache?: Map<string, unknown> },
  ...args: TArgs
): void {
  if (memoized.cache) {
    memoized.cache.delete(defaultKeyFn(...args));
  }
}
