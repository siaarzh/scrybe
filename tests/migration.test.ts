/**
 * Tests for src/schema-version.ts — migration detection and execution.
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
  it("first run (no schema.json): deletes hash files and writes schema version 2", async () => {
    seedOldIndex();
    const { checkAndMigrate } = await import("../src/schema-version.js");

    const result = checkAndMigrate();

    expect(result.migrated).toBe(true);
    expect(result.version).toBe(2);

    // Hash files removed
    expect(existsSync(join(dataDir(), "hashes", "proj__primary.json"))).toBe(false);

    // schema.json written with version 2
    const schema = JSON.parse(readFileSync(join(dataDir(), "schema.json"), "utf8")) as { version: number };
    expect(schema.version).toBe(2);
  });

  it("second run: idempotent — returns migrated=false, version=2", async () => {
    seedOldIndex();
    const { checkAndMigrate } = await import("../src/schema-version.js");

    checkAndMigrate(); // first — migrates
    const second = checkAndMigrate(); // second — no-op

    expect(second.migrated).toBe(false);
    expect(second.version).toBe(2);
  });

  it("SCRYBE_SKIP_MIGRATION=1: skips migration, hash files preserved", async () => {
    seedOldIndex();
    process.env["SCRYBE_SKIP_MIGRATION"] = "1";
    const { checkAndMigrate } = await import("../src/schema-version.js");

    const result = checkAndMigrate();

    expect(result.migrated).toBe(false);
    expect(result.version).toBe(1); // stays at v1

    // Hash files NOT deleted
    expect(existsSync(join(dataDir(), "hashes", "proj__primary.json"))).toBe(true);

    // schema.json NOT written
    expect(existsSync(join(dataDir(), "schema.json"))).toBe(false);
  });
});
