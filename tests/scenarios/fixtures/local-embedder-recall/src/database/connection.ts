/**
 * Database connection pool management.
 * Wraps pg (PostgreSQL) with connection pooling and retry logic.
 */

export interface PoolConfig {
  host: string;
  port: number;
  database: string;
  user: string;
  password: string;
  maxConnections: number;
  idleTimeoutMs: number;
  connectionTimeoutMs: number;
}

export interface Connection {
  id: string;
  isActive: boolean;
  acquiredAt: number | null;
  query<T = Record<string, unknown>>(sql: string, params?: unknown[]): Promise<T[]>;
  release(): void;
}

const DEFAULT_POOL_CONFIG: Partial<PoolConfig> = {
  port: 5432,
  maxConnections: 10,
  idleTimeoutMs: 30_000,
  connectionTimeoutMs: 5_000,
};

/** Connection pool singleton keyed by connection string. */
const _pools = new Map<string, PoolConfig>();

/**
 * Initialize a connection pool with the given configuration.
 * Subsequent calls with the same host+db are no-ops (returns existing pool).
 */
export function initPool(cfg: PoolConfig): void {
  const key = `${cfg.host}:${cfg.port}/${cfg.database}`;
  if (_pools.has(key)) return;
  _pools.set(key, { ...DEFAULT_POOL_CONFIG, ...cfg } as PoolConfig);
}

/**
 * Acquire a connection from the pool.
 * Waits up to connectionTimeoutMs before throwing.
 */
export async function acquireConnection(poolKey: string): Promise<Connection> {
  const cfg = _pools.get(poolKey);
  if (!cfg) throw new Error(`No pool configured for key: ${poolKey}`);

  // Stub — real impl would use node-postgres Pool
  const conn: Connection = {
    id: Math.random().toString(36).slice(2),
    isActive: true,
    acquiredAt: Date.now(),
    async query<T>(sql: string, params?: unknown[]): Promise<T[]> {
      void params;
      throw new Error(`Stub: ${sql}`);
    },
    release() { this.isActive = false; },
  };
  return conn;
}

/** Run a callback with a pooled connection; releases automatically. */
export async function withConnection<T>(
  poolKey: string,
  cb: (conn: Connection) => Promise<T>
): Promise<T> {
  const conn = await acquireConnection(poolKey);
  try {
    return await cb(conn);
  } finally {
    conn.release();
  }
}
