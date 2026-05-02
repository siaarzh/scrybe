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

/** Map of old env var name → new env var name for .env key rewriting. */
const ENV_RENAME_MAP: Record<string, string> = {
  "EMBEDDING_BASE_URL":      "SCRYBE_CODE_EMBEDDING_BASE_URL",
  "EMBEDDING_API_KEY":       "SCRYBE_CODE_EMBEDDING_API_KEY",
  "EMBEDDING_MODEL":         "SCRYBE_CODE_EMBEDDING_MODEL",
  "EMBEDDING_DIMENSIONS":    "SCRYBE_CODE_EMBEDDING_DIMENSIONS",
  "EMBED_BATCH_SIZE":        "SCRYBE_EMBED_BATCH_SIZE",
  "EMBED_BATCH_DELAY_MS":    "SCRYBE_EMBED_BATCH_DELAY_MS",
  "SCRYBE_TEXT_EMBEDDING_BASE_URL":   "SCRYBE_KNOWLEDGE_EMBEDDING_BASE_URL",
  "SCRYBE_TEXT_EMBEDDING_API_KEY":    "SCRYBE_KNOWLEDGE_EMBEDDING_API_KEY",
  "SCRYBE_TEXT_EMBEDDING_MODEL":      "SCRYBE_KNOWLEDGE_EMBEDDING_MODEL",
  "SCRYBE_TEXT_EMBEDDING_DIMENSIONS": "SCRYBE_KNOWLEDGE_EMBEDDING_DIMENSIONS",
};

/**
 * Rewrite old env var names in DATA_DIR/.env to new names.
 * Removes old keys after writing new ones to avoid confusion.
 * Warns if OPENAI_API_KEY was the only auth source.
 * Warns if SCRYBE_RERANK=true was set (rerank key reuse is gone).
 */
function migrateEnvFile(): void {
  const envPath = join(config.dataDir, ".env");
  if (!existsSync(envPath)) return;

  let content: string;
  try {
    content = readFileSync(envPath, "utf8");
  } catch {
    return;
  }

  // Parse lines preserving comments and blanks
  const lines = content.split("\n");
  const parsed: Array<{ key: string; value: string; raw: string }> = [];
  const keysPresent = new Set<string>();

  for (const raw of lines) {
    const trimmed = raw.trim();
    if (!trimmed || trimmed.startsWith("#")) {
      parsed.push({ key: "", value: "", raw });
      continue;
    }
    const eq = trimmed.indexOf("=");
    if (eq === -1) {
      parsed.push({ key: "", value: "", raw });
      continue;
    }
    const key = trimmed.slice(0, eq).trim();
    const value = trimmed.slice(eq + 1).trim();
    parsed.push({ key, value, raw });
    keysPresent.add(key);
  }

  // Check for OPENAI_API_KEY in .env — warn if it was the only embedding auth
  const hadOpenAiKey = keysPresent.has("OPENAI_API_KEY");
  const hadEmbeddingKey = keysPresent.has("EMBEDDING_API_KEY");
  if (hadOpenAiKey && !hadEmbeddingKey) {
    process.stderr.write(
      "[scrybe] migration: OPENAI_API_KEY fallback is removed. " +
      "Set SCRYBE_CODE_EMBEDDING_API_KEY explicitly in your .env.\n"
    );
  }

  // Warn if rerank was likely working via the now-removed key reuse
  if (keysPresent.has("SCRYBE_RERANK") || process.env["SCRYBE_RERANK"] === "true") {
    if (!keysPresent.has("SCRYBE_RERANK_API_KEY")) {
      process.stderr.write(
        "[scrybe] migration: Rerank no longer reuses the embedding API key. " +
        "Set SCRYBE_RERANK_API_KEY to keep rerank working.\n"
      );
    }
  }

  // Build renamed lines — skip old keys after writing new ones
  const renamedKeys = new Set<string>(); // new names we've already written
  const toDelete = new Set<string>();    // old names to drop

  // First pass: collect what needs renaming
  for (const entry of parsed) {
    if (!entry.key) continue;
    const newName = ENV_RENAME_MAP[entry.key];
    if (newName) toDelete.add(entry.key);
  }

  const newLines: string[] = [];
  for (const entry of parsed) {
    if (!entry.key) {
      newLines.push(entry.raw);
      continue;
    }
    const newName = ENV_RENAME_MAP[entry.key];
    if (newName) {
      // Replace old key with new key (unless new key already exists in file)
      if (!keysPresent.has(newName) && !renamedKeys.has(newName)) {
        newLines.push(`${newName}=${entry.value}`);
        renamedKeys.add(newName);
        process.stderr.write(`[scrybe] migration: renamed ${entry.key} → ${newName} in .env\n`);
      } else {
        process.stderr.write(`[scrybe] migration: dropped duplicate ${entry.key} (${newName} already present)\n`);
      }
      // Don't push the old key line
    } else {
      newLines.push(entry.raw);
    }
  }

  const newContent = newLines.join("\n");
  if (newContent !== content) {
    try {
      writeFileSync(envPath, newContent, "utf8");
    } catch (e) {
      process.stderr.write(`[scrybe] migration: could not rewrite .env: ${e}\n`);
    }
  }

  // Also reload the renamed keys into process.env for this run
  for (const [oldKey, newKey] of Object.entries(ENV_RENAME_MAP)) {
    if (renamedKeys.has(newKey) && !process.env[newKey]) {
      const oldVal = process.env[oldKey];
      if (oldVal) process.env[newKey] = oldVal;
    }
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
    id: "rename-env-vars-v0.29.0",
    async run() {
      migrateEnvFile();
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
