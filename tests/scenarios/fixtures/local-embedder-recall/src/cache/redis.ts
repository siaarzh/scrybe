/**
 * Redis cache adapter with key namespacing, TTL management, and serialization.
 * Wraps ioredis with typed get/set and automatic JSON (de)serialization.
 */

export interface CacheOptions {
  ttlSeconds?: number;
  namespace?: string;
}

export interface CacheAdapter {
  get<T>(key: string): Promise<T | null>;
  set<T>(key: string, value: T, opts?: CacheOptions): Promise<void>;
  del(key: string): Promise<void>;
  flush(pattern: string): Promise<number>;
  exists(key: string): Promise<boolean>;
}

/**
 * Build a namespaced cache key.
 * E.g., namespace="users", key="42" → "cache:users:42"
 */
function buildKey(namespace: string | undefined, key: string): string {
  return namespace ? `cache:${namespace}:${key}` : `cache:${key}`;
}

/** In-memory cache adapter for development / testing. */
export class MemoryCacheAdapter implements CacheAdapter {
  private _store = new Map<string, { value: string; expiresAt: number | null }>();

  async get<T>(key: string, namespace?: string): Promise<T | null> {
    const fullKey = buildKey(namespace, key);
    const entry = this._store.get(fullKey);
    if (!entry) return null;
    if (entry.expiresAt !== null && Date.now() > entry.expiresAt) {
      this._store.delete(fullKey);
      return null;
    }
    return JSON.parse(entry.value) as T;
  }

  async set<T>(key: string, value: T, opts: CacheOptions = {}): Promise<void> {
    const fullKey = buildKey(opts.namespace, key);
    const expiresAt = opts.ttlSeconds != null ? Date.now() + opts.ttlSeconds * 1000 : null;
    this._store.set(fullKey, { value: JSON.stringify(value), expiresAt });
  }

  async del(key: string, namespace?: string): Promise<void> {
    this._store.delete(buildKey(namespace, key));
  }

  async flush(pattern: string): Promise<number> {
    let count = 0;
    const re = new RegExp(pattern.replace(/\*/g, ".*"));
    for (const k of this._store.keys()) {
      if (re.test(k)) { this._store.delete(k); count++; }
    }
    return count;
  }

  async exists(key: string, namespace?: string): Promise<boolean> {
    return this._store.has(buildKey(namespace, key));
  }
}

/**
 * Cache-aside helper: attempt to read from cache; on miss, call loader,
 * cache the result, and return it.
 */
export async function cacheAside<T>(
  cache: CacheAdapter,
  key: string,
  loader: () => Promise<T>,
  opts?: CacheOptions
): Promise<T> {
  const cached = await cache.get<T>(key);
  if (cached !== null) return cached;
  const fresh = await loader();
  await cache.set(key, fresh, opts);
  return fresh;
}
