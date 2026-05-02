/**
 * Migration registry — named, idempotent, non-destructive one-time migrations.
 *
 * Each entry runs once per DATA_DIR install. Applied IDs are persisted in
 * schema.json `migrations_applied`. Safe to call on every CLI/daemon start.
 *
 * Contrast with schema-version.ts (destructive version bump, forces full reindex).
 * This registry is for additive/maintenance migrations that must not wipe data.
 */
import { existsSync, readFileSync, writeFileSync } from "fs";
import { join } from "path";
import { config } from "./config.js";
import { listProjects } from "./registry.js";
import { compactTable } from "./vector-store.js";

export interface Migration {
  id: string;
  run(): Promise<void>;
}

/**
 * Auto-copy SCRYBE_CODE_EMBEDDING_API_KEY into SCRYBE_RERANK_API_KEY for users
 * who had SCRYBE_RERANK=true working before v0.29.0 (when the key was reused).
 *
 * Conditions: SCRYBE_RERANK=true AND SCRYBE_CODE_EMBEDDING_API_KEY is set
 * AND SCRYBE_RERANK_API_KEY is NOT yet set → append to .env.
 *
 * Fix 2 (Plan 31): restores prior rerank behaviour for upgraders.
 */
function addRerankKeyIfMissing(): void {
  const envPath = join(config.dataDir, ".env");

  // Parse .env to check current keys
  const keysPresent = new Set<string>();
  const keyValues = new Map<string, string>();
  let envContent = "";

  if (existsSync(envPath)) {
    try {
      envContent = readFileSync(envPath, "utf8");
    } catch { return; }
    for (const line of envContent.split("\n")) {
      const trimmed = line.trim();
      if (!trimmed || trimmed.startsWith("#")) continue;
      const eq = trimmed.indexOf("=");
      if (eq === -1) continue;
      const key = trimmed.slice(0, eq).trim();
      const val = trimmed.slice(eq + 1).trim();
      if (key) { keysPresent.add(key); keyValues.set(key, val); }
    }
  }

  // Check condition: SCRYBE_RERANK=true AND embedding key present AND rerank key absent
  const rerankEnabled =
    (keysPresent.has("SCRYBE_RERANK") && keyValues.get("SCRYBE_RERANK") === "true") ||
    process.env["SCRYBE_RERANK"] === "true";
  const embeddingKey =
    keyValues.get("SCRYBE_CODE_EMBEDDING_API_KEY") ??
    process.env["SCRYBE_CODE_EMBEDDING_API_KEY"] ??
    "";
  const rerankKeyAlreadySet =
    keysPresent.has("SCRYBE_RERANK_API_KEY") ||
    !!process.env["SCRYBE_RERANK_API_KEY"];

  if (!rerankEnabled || !embeddingKey || rerankKeyAlreadySet) return;

  // Append the rerank key line, preserving existing file content
  const appendLine = `SCRYBE_RERANK_API_KEY=${embeddingKey}`;
  const newContent = envContent
    ? (envContent.endsWith("\n") ? envContent + appendLine + "\n" : envContent + "\n" + appendLine + "\n")
    : appendLine + "\n";

  try {
    writeFileSync(envPath, newContent, "utf8");
    process.stderr.write(
      "[scrybe] migration: copied SCRYBE_CODE_EMBEDDING_API_KEY into SCRYBE_RERANK_API_KEY (rerank reuse compatibility)\n"
    );
    // Also set it in process.env for this run
    if (!process.env["SCRYBE_RERANK_API_KEY"]) {
      process.env["SCRYBE_RERANK_API_KEY"] = embeddingKey;
    }
  } catch (e) {
    process.stderr.write(`[scrybe] migration: could not write SCRYBE_RERANK_API_KEY to .env: ${e}\n`);
  }
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
  {
    // Fix 1 (Plan 31): env rename now happens eagerly in loadDotEnv() inside config.ts,
    // BEFORE buildRerankConfig() evaluates. This entry remains registered so the stamp
    // is recorded in schema.json — the run() is a no-op since the work already happened.
    id: "rename-env-vars-v0.29.0",
    async run() {
      // No-op: env rename is now performed at config.ts load time (loadDotEnv).
    },
  },
  {
    // Fix 2 (Plan 31): for users upgrading from ≤0.28.x who had SCRYBE_RERANK=true
    // working via the now-removed embedding-key reuse fallback, auto-copy the key.
    // Must run AFTER rename-env-vars-v0.29.0 so old EMBEDDING_API_KEY has been renamed
    // to SCRYBE_CODE_EMBEDDING_API_KEY before we read it.
    id: "add-rerank-key-v0.29.1",
    async run() {
      addRerankKeyIfMissing();
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
