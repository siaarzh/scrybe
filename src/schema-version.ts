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
import { runPendingMigrations, hasPendingMigrations } from "./migrations.js";
import {
  acquireMigrationLock,
  releaseMigrationLock,
  type AcquireResult,
} from "./daemon/data-dir-lock.js";
import { diagEmit } from "./daemon/events.js";

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

/**
 * Safety-net cap on how long `checkAndMigrate()` will wait for a concurrent
 * holder to release the migration lock (Plan 108 slice 3). This is NOT a
 * per-run duration expectation for a real migration (registry migrations can
 * legitimately take a while compacting tables across every registered
 * project) — it exists solely so a holder that is alive but wedged cannot
 * hang every future CLI/MCP/daemon invocation forever. A holder that has
 * actually crashed is reclaimed on the very next `acquireMigrationLock()`
 * attempt (dead-pid detection in `data-dir-lock.ts`), long before this fires.
 */
const MIGRATION_WAIT_TIMEOUT_MS = 120_000;
const MIGRATION_WAIT_POLL_MS = 50;

/**
 * Poll `acquireMigrationLock()` until it stops reporting "contended" (either
 * because we won it, or because the fs can't arbitrate at all), or until the
 * safety-net timeout elapses. Mirrors the `waitForHealthyPidfile` idiom in
 * `daemon/client.ts`: compute the deadline once, sleep-and-retry in a loop,
 * never throw.
 */
async function waitForMigrationLock(): Promise<AcquireResult> {
  const deadline = Date.now() + MIGRATION_WAIT_TIMEOUT_MS;
  for (;;) {
    const result = acquireMigrationLock();
    // Review G6: on timeout, return the CONTENDED result unchanged — do not
    // launder it into "unavailable". A previous revision did exactly that, and
    // since `checkAndMigrate()` fails open on "unavailable", timing out against
    // a provably LIVE holder ran the destructive migration unprotected. A dead
    // holder is already reclaimed by `acquireMigrationLock()` itself, so a
    // still-contended result after the wait means the holder is genuinely
    // alive — the one case where failing open is wrong.
    if (result.outcome !== "contended") return result;
    if (Date.now() >= deadline) return result;
    await new Promise((r) => setTimeout(r, MIGRATION_WAIT_POLL_MS));
  }
}

/**
 * True when the on-disk schema is already at the current version AND no
 * registry migration is outstanding — i.e. `doCheckAndMigrate()` would take
 * only its read-only tail and change nothing.
 */
function nothingToMigrate(doc: SchemaDoc): boolean {
  return doc.version >= CURRENT_SCHEMA_VERSION && !hasPendingMigrations(doc.migrations_applied);
}

/**
 * Guards the destructive body below with the data-dir-scoped migration lock
 * so it is atomic across `checkAndMigrate()`'s three independent callers
 * (`cli.ts`, `mcp-server.ts`, `main.ts` — Plan 108 defect 4). A caller that
 * loses the race waits for the holder to finish rather than skipping the
 * check: once the wait resolves, `doCheckAndMigrate()` below re-reads
 * `schema.json` fresh, so it correctly sees "already current" (no redundant
 * destructive work) instead of proceeding on stale, half-migrated state.
 */
export async function checkAndMigrate(): Promise<{ migrated: boolean; version: number }> {
  // FAST PATH (review F10). `checkAndMigrate()` runs at the top of EVERY CLI
  // invocation (`cli.ts` runCli) and inside the MCP `initialize` handshake
  // (`mcp-server.ts`). Taking the lock unconditionally meant (a) a
  // write+link+unlink on every `scrybe status`, and worse (b) a blocking wait
  // of up to MIGRATION_WAIT_TIMEOUT_MS against a wedged holder — on precisely
  // the commands (`daemon stop`, `daemon restart`, `status`) an operator would
  // reach for to un-wedge things. Reading the version first is safe without
  // the lock: if it says "already current" there is nothing to serialise, and
  // if it is stale we fall through and re-read it under the lock anyway.
  const preflight = readSchemaDoc();
  if (nothingToMigrate(preflight)) {
    return { migrated: false, version: preflight.version };
  }

  // Review G10: take the SCRYBE_SKIP_MIGRATION decision BEFORE any lock. The
  // skip branch returns without bumping the version, so `nothingToMigrate`
  // above is permanently false for those stores — every CLI invocation, every
  // MCP `initialize` and the installed git hook paid a lock acquire and could
  // block for MIGRATION_WAIT_TIMEOUT_MS behind a wedged holder (a `git commit`
  // hanging two minutes). Nothing is mutated on this path, so no lock is owed.
  if (preflight.version < 2 && process.env.SCRYBE_SKIP_MIGRATION === "1") {
    console.error(
      "[scrybe] SCRYBE_SKIP_MIGRATION=1: running in read-only compatibility mode. " +
      "Branch features are disabled. Run without SCRYBE_SKIP_MIGRATION and re-index to upgrade."
    );
    return { migrated: false, version: preflight.version };
  }

  const lock = await waitForMigrationLock();

  if (lock.outcome === "contended") {
    // Review G6: a live holder is mid-migration. Migrations are destructive
    // (they delete hash files and unlink branch-tags.db) and `migrations_applied`
    // is persisted only AFTER they complete, so proceeding here would run them
    // a second time, concurrently. Refuse instead of racing.
    throw new Error(
      `[scrybe] Another scrybe process (PID ${lock.heldByPid ?? "unknown"}) is migrating the store ` +
      `at ${config.dataDir} and did not finish within ${Math.round(MIGRATION_WAIT_TIMEOUT_MS / 1000)}s. ` +
      `Wait for it to finish and try again. If that process is gone, remove ` +
      `${join(config.dataDir, "daemon-migrate.lock")} by hand.`
    );
  }

  if (lock.outcome === "unavailable") {
    // Fail-open, matching the ownership/spawn lock convention (Plan 108
    // slice 1/2): a permissions/disk fault — or a wedged holder that never
    // releases — must not brick every CLI/MCP/daemon invocation. Proceed
    // unprotected rather than refuse to start.
    diagEmit({
      level: "warn",
      event: "schema.migrate.lock_unavailable",
      dataDir: config.dataDir,
      errorCode: lock.error?.code ?? null,
      errorMessage: lock.error?.message ?? null,
    });
    return doCheckAndMigrate();
  }

  try {
    return await doCheckAndMigrate();
  } finally {
    releaseMigrationLock();
  }
}

async function doCheckAndMigrate(): Promise<{ migrated: boolean; version: number }> {
  const doc = readSchemaDoc();

  if (doc.version < 2) {
    // v1 → branch-aware format: full reset required (one-time, destructive).
    // SCRYBE_SKIP_MIGRATION is handled by checkAndMigrate() before any lock is
    // taken (review G10) — it can never reach here.
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
