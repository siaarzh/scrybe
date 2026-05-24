/**
 * Database schema migration runner.
 * Applies sequential SQL migrations and records applied versions in a
 * `schema_migrations` table to prevent double-application.
 */

export interface Migration {
  version: number;
  name: string;
  up: string;   // SQL to apply
  down: string; // SQL to roll back
}

/** Registry of all available migrations in version order. */
export const MIGRATIONS: Migration[] = [
  {
    version: 1,
    name: "create_users",
    up: `CREATE TABLE users (
      id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      email TEXT UNIQUE NOT NULL,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )`,
    down: "DROP TABLE users",
  },
  {
    version: 2,
    name: "add_user_roles",
    up: `ALTER TABLE users ADD COLUMN role TEXT NOT NULL DEFAULT 'user'`,
    down: `ALTER TABLE users DROP COLUMN role`,
  },
  {
    version: 3,
    name: "create_sessions",
    up: `CREATE TABLE sessions (
      session_id TEXT PRIMARY KEY,
      user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      expires_at TIMESTAMPTZ NOT NULL,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )`,
    down: "DROP TABLE sessions",
  },
];

/**
 * Apply all pending migrations in ascending version order.
 * Skips migrations that are already recorded in schema_migrations.
 */
export async function runMigrations(
  query: (sql: string, params?: unknown[]) => Promise<unknown[]>
): Promise<{ applied: number[]; skipped: number[] }> {
  // Ensure migration tracking table exists
  await query(`
    CREATE TABLE IF NOT EXISTS schema_migrations (
      version INTEGER PRIMARY KEY,
      applied_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )
  `);

  const rows = await query("SELECT version FROM schema_migrations ORDER BY version") as Array<{ version: number }>;
  const applied = new Set(rows.map((r) => r.version));

  const newlyApplied: number[] = [];
  const skipped: number[] = [];

  for (const migration of MIGRATIONS.sort((a, b) => a.version - b.version)) {
    if (applied.has(migration.version)) {
      skipped.push(migration.version);
      continue;
    }
    await query(migration.up);
    await query("INSERT INTO schema_migrations (version) VALUES ($1)", [migration.version]);
    newlyApplied.push(migration.version);
  }

  return { applied: newlyApplied, skipped };
}
