import {
  readFileSync,
  writeFileSync,
  existsSync,
  readdirSync,
  unlinkSync,
  mkdirSync,
} from "fs";
import { join } from "path";
import { config } from "./config.js";
import { closeDB } from "./branch-state.js";
import { runPendingMigrations } from "./migrations.js";

export const CURRENT_SCHEMA_VERSION = 4;

// Updated on each release so schema.json records which version last wrote it
const SCRYBE_VERSION = "0.23.2";

interface SchemaDoc {
  version: number;
  migrations_applied: string[];
  last_written_by: string;
}

function schemaFilePath(): string {
  return join(config.dataDir, "schema.json");
}

function hashesDir(): string {
  return join(config.dataDir, "hashes");
}

function branchTagsDbPath(): string {
  return join(config.dataDir, "branch-tags.db");
}

function readSchemaDoc(): SchemaDoc {
  const p = schemaFilePath();
  if (!existsSync(p)) return { version: 1, migrations_applied: [], last_written_by: "" };
  try {
    const raw = JSON.parse(readFileSync(p, "utf8")) as Partial<SchemaDoc>;
    return {
      version: typeof raw.version === "number" ? raw.version : 1,
      migrations_applied: Array.isArray(raw.migrations_applied) ? raw.migrations_applied : [],
      last_written_by: typeof raw.last_written_by === "string" ? raw.last_written_by : "",
    };
  } catch {
    return { version: 1, migrations_applied: [], last_written_by: "" };
  }
}

function writeSchemaDoc(doc: SchemaDoc): void {
  mkdirSync(config.dataDir, { recursive: true });
  writeFileSync(
    schemaFilePath(),
    JSON.stringify({ ...doc, last_written_by: SCRYBE_VERSION }, null, 2),
    "utf8"
  );
}

export async function checkAndMigrate(): Promise<{ migrated: boolean; version: number }> {
  const doc = readSchemaDoc();

  if (doc.version < 2) {
    // v1 → branch-aware format: full reset required (one-time, destructive)
    if (process.env.SCRYBE_SKIP_MIGRATION === "1") {
      console.error(
        "[scrybe] SCRYBE_SKIP_MIGRATION=1: running in read-only compatibility mode. " +
        "Branch features are disabled. Run without SCRYBE_SKIP_MIGRATION and re-index to upgrade."
      );
      return { migrated: false, version: doc.version };
    }

    console.error(
      "\n[scrybe] Upgrading index to branch-aware format (v2)." +
      "\nThis is a one-time full reindex — all projects will be re-embedded on next index run." +
      "\nTo skip and run read-only: set SCRYBE_SKIP_MIGRATION=1.\n"
    );

    // Delete hash files → forces full reindex on next index command
    const hashes = hashesDir();
    if (existsSync(hashes)) {
      for (const f of readdirSync(hashes)) {
        try { unlinkSync(join(hashes, f)); } catch { /* ignore ENOENT races */ }
      }
    }

    // Close and delete branch-tags.db → fresh start
    closeDB();
    const dbPath = branchTagsDbPath();
    if (existsSync(dbPath)) {
      try { unlinkSync(dbPath); } catch { /* ignore */ }
    }

    doc.version = CURRENT_SCHEMA_VERSION;
    doc.migrations_applied = [];
    writeSchemaDoc(doc);
    return { migrated: true, version: CURRENT_SCHEMA_VERSION };
  }

  if (doc.version === 3) {
    // v3 → v4: additive — adds `type` and `result` columns to the jobs table.
    // Existing rows default to type='reindex'. Done via ALTER TABLE (idempotent via catch).
    try {
      const { getDB } = await import("./branch-state.js");
      const db = getDB();
      db.exec("ALTER TABLE jobs ADD COLUMN type TEXT NOT NULL DEFAULT 'reindex'");
    } catch {
      // Column may already exist (fresh DB created with v4 schema, or migration re-run)
    }
    try {
      const { getDB } = await import("./branch-state.js");
      const db = getDB();
      db.exec("ALTER TABLE jobs ADD COLUMN result TEXT");
    } catch {
      // Same
    }
    doc.version = CURRENT_SCHEMA_VERSION;
    const updatedApplied = await runPendingMigrations(doc.migrations_applied);
    if (updatedApplied.length !== doc.migrations_applied.length) {
      doc.migrations_applied = updatedApplied;
    }
    writeSchemaDoc(doc);
    return { migrated: true, version: CURRENT_SCHEMA_VERSION };
  }

  if (doc.version < CURRENT_SCHEMA_VERSION) {
    // v2 → v3/v4: additive — jobs table is created by IF NOT EXISTS in getDB().
    // Also run the v3→v4 ALTER TABLE to add type/result columns (idempotent).
    try {
      const { getDB } = await import("./branch-state.js");
      const db = getDB();
      db.exec("ALTER TABLE jobs ADD COLUMN type TEXT NOT NULL DEFAULT 'reindex'");
    } catch { /* column already exists or table doesn't exist yet — safe to skip */ }
    try {
      const { getDB } = await import("./branch-state.js");
      const db = getDB();
      db.exec("ALTER TABLE jobs ADD COLUMN result TEXT");
    } catch { /* same */ }
    doc.version = CURRENT_SCHEMA_VERSION;
    // Run pending registry migrations before finalizing the version bump.
    const updatedApplied = await runPendingMigrations(doc.migrations_applied);
    if (updatedApplied.length !== doc.migrations_applied.length) {
      doc.migrations_applied = updatedApplied;
    }
    writeSchemaDoc(doc);
    return { migrated: true, version: CURRENT_SCHEMA_VERSION };
  }

  // Version is current — run any pending registry migrations
  const updatedApplied = await runPendingMigrations(doc.migrations_applied);
  if (updatedApplied.length !== doc.migrations_applied.length) {
    writeSchemaDoc({ ...doc, migrations_applied: updatedApplied });
  }

  return { migrated: false, version: doc.version };
}
