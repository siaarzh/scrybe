/**
 * Tests for src/schema-version.ts — migration detection and execution.
 * Also covers Fix 6: migration registry + migrations_applied tracking.
 */
import { describe, it, expect, afterEach } from "vitest";
import { writeFileSync, mkdirSync, existsSync, readFileSync } from "fs";
import { join } from "path";

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
    expect(typeof schema.last_written_by).toBe("string");
    expect(schema.last_written_by.length).toBeGreaterThan(0);
  });

  it("already-applied migrations are not run again (idempotent)", async () => {
    mkdirSync(dataDir(), { recursive: true });
    writeFileSync(
      join(dataDir(), "schema.json"),
      JSON.stringify({ version: 2, migrations_applied: ["compact-tables-v0.23.2"] }),
      "utf8"
    );

    const { runPendingMigrations } = await import("../src/migrations.js");
    const result = await runPendingMigrations(["compact-tables-v0.23.2"]);

    // No new IDs added — already applied
    expect(result).toEqual(["compact-tables-v0.23.2"]);
  });

  it("pending migration is added to applied list", async () => {
    const { runPendingMigrations } = await import("../src/migrations.js");
    // Start with empty applied list — migration should run (no-op on empty registry)
    const result = await runPendingMigrations([]);
    expect(result).toContain("compact-tables-v0.23.2");
  });
});
