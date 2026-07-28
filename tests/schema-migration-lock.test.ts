/**
 * Plan 108 Slice 3 — atomic checkAndMigrate() integration tests.
 *
 * `checkAndMigrate()` (src/schema-version.ts) is the only genuinely
 * destructive operation in the startup path (deletes hash files, unlinks
 * branch-tags.db) and is called from three independent entry points —
 * cli.ts, mcp-server.ts, main.ts — with no cross-process atomicity before
 * this slice. These tests spawn REAL concurrent child processes (`node
 * dist/index.js project list`, which reaches `checkAndMigrate()` at the top
 * of `runCli()` before any subcommand logic, and calls neither
 * `ensureRunning()` nor spawns a daemon) against a scratch SCRYBE_DATA_DIR —
 * never the real `~/.local/share/scrybe`.
 *
 * Scenario A races the destructive v1→v2 migration: it must run exactly
 * once (observable via the one-time stderr banner), and every racing process
 * must exit 0 — none may proceed on a half-migrated store.
 *
 * Scenario B races the additive v2→v4 migration (ALTER TABLE / IF NOT EXISTS,
 * no deletion) against a REAL pre-existing branch-tags.db with real data: the
 * file must survive the race intact — schema upgraded, prior rows untouched —
 * proving the lock protects the additive path too, not just the destructive
 * one. (Deliberately v2, not v3: a v3 store whose `jobs` table already exists
 * without the `type`/`result` columns hits a PRE-EXISTING, unrelated bug —
 * `getDB()`'s own `CREATE INDEX idx_jobs_type_project ON jobs(type, ...)`
 * throws "no such column: type" before the v3→v4 branch's `ALTER TABLE` ever
 * gets a chance to add it, on every invocation, lock or no lock. Confirmed
 * on the unmodified pre-slice-3 code path too — out of scope for this slice,
 * noted for a follow-up, not fixed here.)
 */
import { describe, it, expect, afterEach } from "vitest";
import { spawn } from "child_process";
import { DatabaseSync } from "node:sqlite";
import { existsSync, readFileSync, writeFileSync, mkdtempSync, mkdirSync, rmSync } from "fs";
import { join } from "path";
import { tmpdir } from "os";

const NODE = process.execPath;
const ENTRY = join(process.cwd(), "dist/index.js");
const CONCURRENCY = 6;

function makeDataDir() {
  return mkdtempSync(join(tmpdir(), "scrybe-migrate-lock-test-"));
}

interface ChildResult {
  status: number | null;
  stdout: string;
  stderr: string;
}

function runChild(dataDir: string): Promise<ChildResult> {
  return new Promise((resolve, reject) => {
    const env = { ...process.env, SCRYBE_DATA_DIR: dataDir };
    const child = spawn(NODE, [ENTRY, "project", "list"], {
      env,
      stdio: ["ignore", "pipe", "pipe"],
      windowsHide: true,
    });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (c) => { stdout += c.toString(); });
    child.stderr.on("data", (c) => { stderr += c.toString(); });
    child.once("error", reject);
    child.once("exit", (code) => resolve({ status: code, stdout, stderr }));
  });
}

async function raceConcurrent(dataDir: string, n: number): Promise<ChildResult[]> {
  return Promise.all(Array.from({ length: n }, () => runChild(dataDir)));
}

const activeDataDirs: string[] = [];

afterEach(() => {
  for (const d of activeDataDirs) {
    try { rmSync(d, { recursive: true, force: true }); } catch { /* ignore */ }
  }
  activeDataDirs.length = 0;
});

describe("schema migration lock — destructive v1→v2 race", () => {
  it(
    "N concurrent CLI invocations against a fresh store run the destructive migration exactly once",
    async () => {
      const dataDir = makeDataDir();
      activeDataDirs.push(dataDir);
      // No schema.json at all → readSchemaDoc() defaults to {version: 1, ...},
      // which is the destructive v1→v2 branch (schema-version.ts).

      const results = await raceConcurrent(dataDir, CONCURRENCY);

      // No caller may crash or be left proceeding on a half-migrated store.
      for (const r of results) {
        expect(r.status).toBe(0);
      }

      // The destructive banner is only printed by the branch body itself
      // (doCheckAndMigrate's v1→v2 path) — a caller that waited for the lock
      // re-reads schema.json fresh afterwards and finds it already current,
      // so it never re-enters that branch. Exactly one process should have
      // actually run it.
      const winners = results.filter((r) =>
        r.stderr.includes("Upgrading index to branch-aware format")
      );
      expect(winners.length).toBe(1);

      // Final state: schema.json bumped to CURRENT_SCHEMA_VERSION exactly once.
      const schemaPath = join(dataDir, "schema.json");
      expect(existsSync(schemaPath)).toBe(true);
      const doc = JSON.parse(readFileSync(schemaPath, "utf8"));
      expect(doc.version).toBe(4);

      // The migration lock must not leak past the race.
      expect(existsSync(join(dataDir, "daemon-migrate.lock"))).toBe(false);
    },
    60_000
  );
});

describe("schema migration lock — data dir that does not exist yet (review F9)", () => {
  it(
    "N concurrent CLI invocations against a NON-PRE-CREATED data dir still run the destructive migration exactly once",
    async () => {
      // The `mkdirSync(dataDir)`-before-lock originally landed ONLY in
      // runDaemon(). checkAndMigrate()'s other two callers — cli.ts (every CLI
      // invocation) and mcp-server.ts — had nothing creating the dir, so on a
      // fresh install tryCreateLock got ENOENT → "unavailable" → fail-open, and
      // the DESTRUCTIVE v1→v2 branch ran with no lock at all. The diagnostic
      // was swallowed for the same reason (daemon-log.jsonl lives in that dir).
      //
      // Scenario A above cannot see this: mkdtempSync PRE-CREATES the dir. This
      // one deliberately does not — the path below has never existed.
      const parent = makeDataDir();
      activeDataDirs.push(parent);
      const dataDir = join(parent, "fresh-install", "never-created");
      expect(existsSync(dataDir)).toBe(false);

      const results = await raceConcurrent(dataDir, CONCURRENCY);

      for (const r of results) {
        expect(r.status, r.stderr).toBe(0);
      }

      const winners = results.filter((r) =>
        r.stderr.includes("Upgrading index to branch-aware format")
      );
      expect(winners.length).toBe(1);

      const doc = JSON.parse(readFileSync(join(dataDir, "schema.json"), "utf8"));
      expect(doc.version).toBe(4);
      expect(existsSync(join(dataDir, "daemon-migrate.lock"))).toBe(false);
    },
    60_000
  );
});

describe("schema migration lock — no-op fast path (review F10)", () => {
  it(
    "an already-current store neither takes the lock nor blocks behind a wedged holder",
    async () => {
      // checkAndMigrate() runs at the TOP of runCli(), i.e. before every single
      // CLI command. Taking the lock unconditionally meant a write+link+unlink
      // per invocation and — far worse — a blocking wait of up to
      // MIGRATION_WAIT_TIMEOUT_MS (120 s) against an alive-but-wedged holder,
      // on exactly the commands (`daemon stop`, `daemon restart`, `status`) an
      // operator reaches for to un-wedge things. Reading the version first is
      // safe: if there is nothing to migrate there is nothing to serialise.
      const dataDir = makeDataDir();
      activeDataDirs.push(dataDir);

      // Normalise the store to "nothing left to do". Two runs are needed, not
      // one: the destructive v1→v2 branch bumps the version but resets
      // `migrations_applied` to [] WITHOUT running the registry migrations, so
      // the second invocation is the one that drains them. (Pre-existing
      // behaviour, unrelated to this review — just what the fixture needs.)
      for (let i = 0; i < 2; i++) {
        const warmup = await runChild(dataDir);
        expect(warmup.status, warmup.stderr).toBe(0);
      }
      const warmDoc = JSON.parse(readFileSync(join(dataDir, "schema.json"), "utf8"));
      expect(warmDoc.version).toBe(4);
      expect(warmDoc.migrations_applied.length).toBeGreaterThan(0);

      // A wedged holder: pid 1 is alive and not us, and the migration lock has
      // NO age expiry by design, so this would block the full 120 s ceiling.
      const migrateLock = join(dataDir, "daemon-migrate.lock");
      writeFileSync(migrateLock, JSON.stringify({ pid: 1, acquiredAt: new Date().toISOString() }), "utf8");

      const t0 = Date.now();
      const result = await runChild(dataDir);
      const elapsedMs = Date.now() - t0;

      expect(result.status, result.stderr).toBe(0);
      expect(elapsedMs).toBeLessThan(30_000); // vs. the 120 s ceiling it used to pay
      // The foreign lock is untouched — proof we never even attempted to take it.
      expect(existsSync(migrateLock)).toBe(true);
      expect(JSON.parse(readFileSync(migrateLock, "utf8")).pid).toBe(1);
    },
    90_000
  );
});

describe("schema migration lock — additive v2→v4 race", () => {
  it(
    "N concurrent CLI invocations against a store needing the additive migration: branch-tags.db survives with data intact",
    async () => {
      const dataDir = makeDataDir();
      activeDataDirs.push(dataDir);
      mkdirSync(dataDir, { recursive: true });

      // Pre-existing store on schema v2 — branch_tags table exists with real
      // rows (pre-jobs-table era); the jobs table does not exist yet, so
      // getDB()'s own CREATE TABLE IF NOT EXISTS creates it fresh (with
      // type/result already in the definition) rather than ALTER-ing an
      // existing one — the genuine, non-buggy additive path.
      writeFileSync(
        join(dataDir, "schema.json"),
        JSON.stringify({ version: 2, migrations_applied: [], last_written_by: "" }),
        "utf8"
      );

      const dbPath = join(dataDir, "branch-tags.db");
      const setupDb = new DatabaseSync(dbPath);
      setupDb.exec(`
        CREATE TABLE IF NOT EXISTS branch_tags (
          project_id  TEXT NOT NULL,
          source_id   TEXT NOT NULL,
          branch      TEXT NOT NULL,
          file_path   TEXT NOT NULL,
          chunk_id    TEXT NOT NULL,
          start_line  INTEGER NOT NULL,
          end_line    INTEGER NOT NULL,
          PRIMARY KEY (project_id, source_id, branch, file_path, chunk_id)
        );
      `);
      setupDb.prepare(
        `INSERT INTO branch_tags (project_id, source_id, branch, file_path, chunk_id, start_line, end_line)
         VALUES ('proj-a', 'src', 'master', 'a.ts', 'chunk1', 1, 10)`
      ).run();
      setupDb.close();

      const results = await raceConcurrent(dataDir, CONCURRENCY);

      for (const r of results) {
        expect(r.status).toBe(0);
      }

      // schema.json must land on CURRENT_SCHEMA_VERSION.
      const doc = JSON.parse(readFileSync(join(dataDir, "schema.json"), "utf8"));
      expect(doc.version).toBe(4);

      // branch-tags.db must survive the race intact: still openable, the
      // jobs table now exists with type/result, and the pre-existing
      // branch_tags row is untouched.
      expect(existsSync(dbPath)).toBe(true);
      const verifyDb = new DatabaseSync(dbPath);
      try {
        const columns = verifyDb.prepare("PRAGMA table_info(jobs)").all() as Array<{ name: string }>;
        const columnNames = columns.map((c) => c.name);
        expect(columnNames).toContain("type");
        expect(columnNames).toContain("result");

        const row = verifyDb.prepare(
          "SELECT project_id, branch, start_line, end_line FROM branch_tags WHERE chunk_id = 'chunk1'"
        ).get() as { project_id: string; branch: string; start_line: number; end_line: number } | undefined;
        expect(row).toBeTruthy();
        expect(row?.project_id).toBe("proj-a");
        expect(row?.branch).toBe("master");
        expect(row?.start_line).toBe(1);
        expect(row?.end_line).toBe(10);
      } finally {
        verifyDb.close();
      }

      expect(existsSync(join(dataDir, "daemon-migrate.lock"))).toBe(false);
    },
    60_000
  );
});
