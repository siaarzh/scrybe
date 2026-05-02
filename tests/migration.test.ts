/**
 * Tests for src/schema-version.ts — migration detection and execution.
 * Also covers Fix 6: migration registry + migrations_applied tracking.
 * Plan 33: zombie-job cleanup migration.
 */
import { describe, it, expect, afterEach } from "vitest";
import { writeFileSync, mkdirSync, existsSync, readFileSync } from "fs";
import { join } from "path";
import { DatabaseSync } from "node:sqlite";

function dataDir(): string {
  return process.env["SCRYBE_DATA_DIR"]!;
}

function seedOldIndex(): void {
  const dir = dataDir();
  const hashes = join(dir, "hashes");
  mkdirSync(hashes, { recursive: true });
  writeFileSync(join(hashes, "proj__primary.json"), JSON.stringify({ "src/alpha.ts": "abc" }), "utf8");
}

afterEach(() => {
  delete process.env["SCRYBE_SKIP_MIGRATION"];
});

describe("checkAndMigrate", () => {
  it("first run (no schema.json): deletes hash files and writes current schema version", async () => {
    seedOldIndex();
    const { checkAndMigrate, CURRENT_SCHEMA_VERSION } = await import("../src/schema-version.js");

    const result = await checkAndMigrate();

    expect(result.migrated).toBe(true);
    expect(result.version).toBe(CURRENT_SCHEMA_VERSION);

    // Hash files removed
    expect(existsSync(join(dataDir(), "hashes", "proj__primary.json"))).toBe(false);

    // schema.json written with current version
    const schema = JSON.parse(readFileSync(join(dataDir(), "schema.json"), "utf8")) as { version: number };
    expect(schema.version).toBe(CURRENT_SCHEMA_VERSION);
  });

  it("second run: idempotent — returns migrated=false, current version", async () => {
    seedOldIndex();
    const { checkAndMigrate, CURRENT_SCHEMA_VERSION } = await import("../src/schema-version.js");

    await checkAndMigrate(); // first — migrates
    const second = await checkAndMigrate(); // second — no-op

    expect(second.migrated).toBe(false);
    expect(second.version).toBe(CURRENT_SCHEMA_VERSION);
  });

  it("SCRYBE_SKIP_MIGRATION=1: skips migration, hash files preserved", async () => {
    seedOldIndex();
    process.env["SCRYBE_SKIP_MIGRATION"] = "1";
    const { checkAndMigrate } = await import("../src/schema-version.js");

    const result = await checkAndMigrate();

    expect(result.migrated).toBe(false);
    expect(result.version).toBe(1); // stays at v1

    // Hash files NOT deleted
    expect(existsSync(join(dataDir(), "hashes", "proj__primary.json"))).toBe(true);

    // schema.json NOT written
    expect(existsSync(join(dataDir(), "schema.json"))).toBe(false);
  });
});

describe("migration registry (Fix 6)", () => {
  it("fresh DATA_DIR: migrations_applied is empty before first run, populated after", async () => {
    // Write a v2 schema.json with no migrations_applied (simulates existing install pre-0.23.2)
    mkdirSync(dataDir(), { recursive: true });
    writeFileSync(
      join(dataDir(), "schema.json"),
      JSON.stringify({ version: 2 }),
      "utf8"
    );

    const { checkAndMigrate } = await import("../src/schema-version.js");
    await checkAndMigrate();

    const schema = JSON.parse(readFileSync(join(dataDir(), "schema.json"), "utf8")) as {
      version: number;
      migrations_applied: string[];
      last_written_by: string;
    };
    expect(schema.migrations_applied).toContain("compact-tables-v0.23.2");
    expect(schema.migrations_applied).toContain("rename-env-vars-v0.29.0");
    expect(schema.migrations_applied).toContain("add-rerank-key-v0.29.1");
    expect(schema.migrations_applied).toContain("cleanup-zombie-jobs-v0.29.3");
    expect(typeof schema.last_written_by).toBe("string");
    expect(schema.last_written_by.length).toBeGreaterThan(0);
  });

  it("already-applied migrations are not run again (idempotent)", async () => {
    mkdirSync(dataDir(), { recursive: true });
    const allApplied = [
      "compact-tables-v0.23.2",
      "rename-env-vars-v0.29.0",
      "add-rerank-key-v0.29.1",
      "cleanup-zombie-jobs-v0.29.3",
    ];
    writeFileSync(
      join(dataDir(), "schema.json"),
      JSON.stringify({ version: 2, migrations_applied: allApplied }),
      "utf8"
    );

    const { runPendingMigrations } = await import("../src/migrations.js");
    const result = await runPendingMigrations(allApplied);

    // No new IDs added — already applied
    expect(result).toEqual(allApplied);
  });

  it("pending migrations are added to applied list", async () => {
    const { runPendingMigrations } = await import("../src/migrations.js");
    // Start with empty applied list — all migrations should run (no-op on empty registry)
    const result = await runPendingMigrations([]);
    expect(result).toContain("compact-tables-v0.23.2");
    expect(result).toContain("rename-env-vars-v0.29.0");
    expect(result).toContain("add-rerank-key-v0.29.1");
    expect(result).toContain("cleanup-zombie-jobs-v0.29.3");
  });

  it("add-rerank-key-v0.29.1 is registered after rename-env-vars-v0.29.0", async () => {
    const { runPendingMigrations } = await import("../src/migrations.js");
    const result = await runPendingMigrations([]);
    const renameIdx = result.indexOf("rename-env-vars-v0.29.0");
    const rerankIdx = result.indexOf("add-rerank-key-v0.29.1");
    expect(renameIdx).toBeGreaterThanOrEqual(0);
    expect(rerankIdx).toBeGreaterThan(renameIdx);
  });

  it("cleanup-zombie-jobs-v0.29.3 is registered and runs after add-rerank-key-v0.29.1", async () => {
    const { runPendingMigrations } = await import("../src/migrations.js");
    const result = await runPendingMigrations([]);
    expect(result).toContain("cleanup-zombie-jobs-v0.29.3");
    const rerankIdx = result.indexOf("add-rerank-key-v0.29.1");
    const zombieIdx = result.indexOf("cleanup-zombie-jobs-v0.29.3");
    expect(zombieIdx).toBeGreaterThan(rerankIdx);
  });
});

describe("Plan 33 — cleanup-zombie-jobs-v0.29.3 migration", () => {
  it("cancels queued/running jobs for removed projects", async () => {
    const dir = dataDir();
    mkdirSync(dir, { recursive: true });

    // Seed branch-tags.db with zombie jobs (project 'ghost' not in projects.json)
    const dbPath = join(dir, "branch-tags.db");
    const db = new DatabaseSync(dbPath);
    db.exec(`CREATE TABLE IF NOT EXISTS jobs (
      job_id TEXT PRIMARY KEY,
      project_id TEXT NOT NULL,
      source_id TEXT,
      branch TEXT,
      mode TEXT NOT NULL DEFAULT 'incremental',
      status TEXT NOT NULL,
      phase TEXT,
      queued_at INTEGER NOT NULL,
      started_at INTEGER,
      finished_at INTEGER,
      error_message TEXT,
      origin TEXT NOT NULL DEFAULT 'daemon',
      type TEXT NOT NULL DEFAULT 'reindex',
      result TEXT
    )`);
    db.prepare(
      "INSERT INTO jobs (job_id, project_id, mode, status, queued_at, origin, type) VALUES (?,?,?,?,?,?,?)"
    ).run("zombie-q-001", "ghost-project", "incremental", "queued", Date.now(), "daemon", "gc");
    db.prepare(
      "INSERT INTO jobs (job_id, project_id, mode, status, queued_at, origin, type) VALUES (?,?,?,?,?,?,?)"
    ).run("zombie-r-001", "ghost-project", "incremental", "running", Date.now(), "daemon", "reindex");

    // projects.json does NOT contain 'ghost-project'
    writeFileSync(
      join(dir, "projects.json"),
      JSON.stringify([]),
      "utf8"
    );

    const { runPendingMigrations } = await import("../src/migrations.js");
    const result = await runPendingMigrations([
      "compact-tables-v0.23.2",
      "rename-env-vars-v0.29.0",
      "add-rerank-key-v0.29.1",
    ]);

    expect(result).toContain("cleanup-zombie-jobs-v0.29.3");

    // Both zombie jobs should now be cancelled
    const q = db.prepare("SELECT status, error_message FROM jobs WHERE job_id=?").get("zombie-q-001") as { status: string; error_message: string } | undefined;
    const r = db.prepare("SELECT status, error_message FROM jobs WHERE job_id=?").get("zombie-r-001") as { status: string; error_message: string } | undefined;

    expect(q?.status).toBe("cancelled");
    expect(q?.error_message).toContain("zombie cleanup");
    expect(r?.status).toBe("cancelled");
    expect(r?.error_message).toContain("zombie cleanup");
  });

  it("does not cancel jobs for valid projects", async () => {
    const dir = dataDir();
    mkdirSync(dir, { recursive: true });

    const dbPath = join(dir, "branch-tags.db");
    const db = new DatabaseSync(dbPath);
    db.exec(`CREATE TABLE IF NOT EXISTS jobs (
      job_id TEXT PRIMARY KEY,
      project_id TEXT NOT NULL,
      source_id TEXT,
      branch TEXT,
      mode TEXT NOT NULL DEFAULT 'incremental',
      status TEXT NOT NULL,
      phase TEXT,
      queued_at INTEGER NOT NULL,
      started_at INTEGER,
      finished_at INTEGER,
      error_message TEXT,
      origin TEXT NOT NULL DEFAULT 'daemon',
      type TEXT NOT NULL DEFAULT 'reindex',
      result TEXT
    )`);
    db.prepare(
      "INSERT INTO jobs (job_id, project_id, mode, status, queued_at, origin, type) VALUES (?,?,?,?,?,?,?)"
    ).run("valid-q-001", "my-project", "incremental", "queued", Date.now(), "daemon", "reindex");

    // projects.json DOES contain 'my-project'
    writeFileSync(
      join(dir, "projects.json"),
      JSON.stringify([{ id: "my-project", description: "", sources: [] }]),
      "utf8"
    );

    const { runPendingMigrations } = await import("../src/migrations.js");
    await runPendingMigrations([
      "compact-tables-v0.23.2",
      "rename-env-vars-v0.29.0",
      "add-rerank-key-v0.29.1",
    ]);

    const row = db.prepare("SELECT status FROM jobs WHERE job_id=?").get("valid-q-001") as { status: string } | undefined;
    expect(row?.status).toBe("queued"); // untouched
  });

  it("is idempotent — second run is a no-op", async () => {
    const dir = dataDir();
    mkdirSync(dir, { recursive: true });

    // Empty DB + empty projects.json
    const dbPath = join(dir, "branch-tags.db");
    const db = new DatabaseSync(dbPath);
    db.exec(`CREATE TABLE IF NOT EXISTS jobs (
      job_id TEXT PRIMARY KEY,
      project_id TEXT NOT NULL,
      source_id TEXT,
      branch TEXT,
      mode TEXT NOT NULL DEFAULT 'incremental',
      status TEXT NOT NULL,
      phase TEXT,
      queued_at INTEGER NOT NULL,
      started_at INTEGER,
      finished_at INTEGER,
      error_message TEXT,
      origin TEXT NOT NULL DEFAULT 'daemon',
      type TEXT NOT NULL DEFAULT 'reindex',
      result TEXT
    )`);
    writeFileSync(join(dir, "projects.json"), JSON.stringify([]), "utf8");

    const { runPendingMigrations } = await import("../src/migrations.js");

    // Run once — stamps it
    const first = await runPendingMigrations([
      "compact-tables-v0.23.2", "rename-env-vars-v0.29.0", "add-rerank-key-v0.29.1",
    ]);
    expect(first).toContain("cleanup-zombie-jobs-v0.29.3");

    // Run again — already applied, skipped
    const second = await runPendingMigrations(first);
    expect(second).toEqual(first);
  });
});

describe("Fix 1 — rename-env-vars-v0.29.0 is a no-op in migration registry", () => {
  it("running rename migration twice does not error and produces no output (no-op)", async () => {
    // The actual rename work now happens in loadDotEnv (config.ts).
    // The migration run() itself must be a no-op — calling it directly should not throw.
    const { runPendingMigrations } = await import("../src/migrations.js");

    // First call — stamps the migration
    const first = await runPendingMigrations([]);
    expect(first).toContain("rename-env-vars-v0.29.0");

    // Second call with all already applied — must be idempotent
    const second = await runPendingMigrations(first);
    expect(second).toEqual(first);
  });
});

describe("Fix 2 — add-rerank-key-v0.29.1 migration", () => {
  it("copies SCRYBE_CODE_EMBEDDING_API_KEY into SCRYBE_RERANK_API_KEY when rerank=true and key missing", async () => {
    const dir = dataDir();
    mkdirSync(dir, { recursive: true });
    const envPath = join(dir, ".env");
    writeFileSync(
      envPath,
      "SCRYBE_RERANK=true\nSCRYBE_CODE_EMBEDDING_API_KEY=voyage-key-abc\n",
      "utf8"
    );

    // Ensure SCRYBE_RERANK_API_KEY is not set in process.env
    const savedKey = process.env["SCRYBE_RERANK_API_KEY"];
    delete process.env["SCRYBE_RERANK_API_KEY"];

    try {
      const { runPendingMigrations } = await import("../src/migrations.js");
      await runPendingMigrations(["compact-tables-v0.23.2", "rename-env-vars-v0.29.0"]);

      const envContent = readFileSync(envPath, "utf8");
      expect(envContent).toContain("SCRYBE_RERANK_API_KEY=voyage-key-abc");
    } finally {
      if (savedKey !== undefined) process.env["SCRYBE_RERANK_API_KEY"] = savedKey;
    }
  });

  it("does NOT overwrite an existing SCRYBE_RERANK_API_KEY", async () => {
    const dir = dataDir();
    mkdirSync(dir, { recursive: true });
    const envPath = join(dir, ".env");
    writeFileSync(
      envPath,
      "SCRYBE_RERANK=true\nSCRYBE_CODE_EMBEDDING_API_KEY=voyage-key-abc\nSCRYBE_RERANK_API_KEY=existing-rerank-key\n",
      "utf8"
    );

    const savedKey = process.env["SCRYBE_RERANK_API_KEY"];
    delete process.env["SCRYBE_RERANK_API_KEY"];

    try {
      const { runPendingMigrations } = await import("../src/migrations.js");
      await runPendingMigrations(["compact-tables-v0.23.2", "rename-env-vars-v0.29.0"]);

      const envContent = readFileSync(envPath, "utf8");
      // Should still have the original rerank key, not the embedding key
      expect(envContent).toContain("SCRYBE_RERANK_API_KEY=existing-rerank-key");
      // Should NOT have duplicated it
      const matches = envContent.match(/SCRYBE_RERANK_API_KEY=/g);
      expect(matches?.length ?? 0).toBe(1);
    } finally {
      if (savedKey !== undefined) process.env["SCRYBE_RERANK_API_KEY"] = savedKey;
    }
  });

  it("does nothing when SCRYBE_RERANK is not true", async () => {
    const dir = dataDir();
    mkdirSync(dir, { recursive: true });
    const envPath = join(dir, ".env");
    writeFileSync(
      envPath,
      "SCRYBE_CODE_EMBEDDING_API_KEY=voyage-key-abc\n",
      "utf8"
    );

    const savedKey = process.env["SCRYBE_RERANK_API_KEY"];
    const savedRerank = process.env["SCRYBE_RERANK"];
    delete process.env["SCRYBE_RERANK_API_KEY"];
    delete process.env["SCRYBE_RERANK"];

    try {
      const { runPendingMigrations } = await import("../src/migrations.js");
      await runPendingMigrations(["compact-tables-v0.23.2", "rename-env-vars-v0.29.0"]);

      const envContent = readFileSync(envPath, "utf8");
      // SCRYBE_RERANK_API_KEY should not be added
      expect(envContent).not.toContain("SCRYBE_RERANK_API_KEY");
    } finally {
      if (savedKey !== undefined) process.env["SCRYBE_RERANK_API_KEY"] = savedKey;
      if (savedRerank !== undefined) process.env["SCRYBE_RERANK"] = savedRerank;
    }
  });
});
