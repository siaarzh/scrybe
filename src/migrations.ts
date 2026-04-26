/**
 * Migration registry — named, idempotent, non-destructive one-time migrations.
 *
 * Each entry runs once per DATA_DIR install. Applied IDs are persisted in
 * schema.json `migrations_applied`. Safe to call on every CLI/daemon start.
 *
 * Contrast with schema-version.ts (destructive version bump, forces full reindex).
 * This registry is for additive/maintenance migrations that must not wipe data.
 */
import { listProjects } from "./registry.js";
import { compactTable } from "./vector-store.js";

export interface Migration {
  id: string;
  run(): Promise<void>;
}

const MIGRATIONS: Migration[] = [
  {
    id: "compact-tables-v0.23.2",
    async run() {
      const projects = listProjects();
      for (const p of projects) {
        for (const s of p.sources) {
          if (!s.table_name) continue;
          process.stderr.write(`[scrybe] migrating: compacting ${p.id}/${s.source_id}...\n`);
          try {
            await compactTable(s.table_name);
          } catch {
            // Table may not exist yet (fresh install) — safe to skip
          }
        }
      }
    },
  },
];

/**
 * Run any migrations not yet in `appliedIds`.
 * Returns the updated list of applied IDs (caller must persist).
 */
export async function runPendingMigrations(appliedIds: string[]): Promise<string[]> {
  const applied = new Set(appliedIds);
  const result = [...appliedIds];
  for (const migration of MIGRATIONS) {
    if (applied.has(migration.id)) continue;
    await migration.run();
    result.push(migration.id);
  }
  return result;
}
