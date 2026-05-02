/**
 * Scenario: .env migration — old EMBEDDING_* keys in DATA_DIR/.env are renamed
 * to SCRYBE_CODE_EMBEDDING_* on first run after upgrade.
 *
 * Spawns the real binary with an old-style .env and verifies:
 * 1. The migration renames keys in place.
 * 2. Old keys are removed from the file.
 * 3. The migration is idempotent.
 * 4. OPENAI_API_KEY-only auth surfaces a migration warning.
 *
 * Each test writes a schema.json that marks the installation as already at
 * schema v4 (current), so the destructive v1→v2 upgrade doesn't interfere.
 * The rename migration ID is not in migrations_applied, so it runs on first spawn.
 */
import { describe, it, expect, afterEach } from "vitest";
import { mkdirSync, writeFileSync, readFileSync } from "fs";
import { join } from "path";
import { makeScenarioEnv, runScrybe, type ScenarioEnv } from "./helpers/spawn.js";

let env: ScenarioEnv | null = null;

afterEach(() => {
  env?.cleanup();
  env = null;
});

/** Seed DATA_DIR with a v4 schema.json that has only the older migrations applied. */
function seedSchema(dataDir: string): void {
  mkdirSync(dataDir, { recursive: true });
  writeFileSync(
    join(dataDir, "schema.json"),
    JSON.stringify({
      version: 4,
      migrations_applied: ["compact-tables-v0.23.2"],
      last_written_by: "0.28.2",
    }),
    "utf8"
  );
}

describe("env-var migration (.env rename)", () => {
  it("renames EMBEDDING_* keys to SCRYBE_CODE_EMBEDDING_* in DATA_DIR/.env", () => {
    env = makeScenarioEnv();
    seedSchema(env.dataDir);
    writeFileSync(
      join(env.dataDir, ".env"),
      [
        "EMBEDDING_BASE_URL=https://api.voyageai.com/v1",
        "EMBEDDING_API_KEY=test-key",
        "EMBEDDING_MODEL=voyage-code-3",
        "EMBEDDING_DIMENSIONS=1024",
        "EMBED_BATCH_SIZE=50",
        "EMBED_BATCH_DELAY_MS=100",
      ].join("\n") + "\n"
    );

    // Run any command that triggers checkAndMigrate (e.g. project list)
    const result = runScrybe(["project", "list"], env);

    expect(result.exit).toBe(0);

    const envContent = readFileSync(join(env.dataDir, ".env"), "utf8");

    // New keys should be present
    expect(envContent).toContain("SCRYBE_CODE_EMBEDDING_BASE_URL=https://api.voyageai.com/v1");
    expect(envContent).toContain("SCRYBE_CODE_EMBEDDING_API_KEY=test-key");
    expect(envContent).toContain("SCRYBE_CODE_EMBEDDING_MODEL=voyage-code-3");
    expect(envContent).toContain("SCRYBE_CODE_EMBEDDING_DIMENSIONS=1024");
    expect(envContent).toContain("SCRYBE_EMBED_BATCH_SIZE=50");
    expect(envContent).toContain("SCRYBE_EMBED_BATCH_DELAY_MS=100");

    // Old keys should be gone (use line-start pattern to avoid matching new keys that contain old key as substring)
    const lines = envContent.split("\n");
    expect(lines.some((l) => l.startsWith("EMBEDDING_BASE_URL="))).toBe(false);
    expect(lines.some((l) => l.startsWith("EMBEDDING_API_KEY="))).toBe(false);
    expect(lines.some((l) => l.startsWith("EMBEDDING_MODEL="))).toBe(false);
    expect(lines.some((l) => l.startsWith("EMBEDDING_DIMENSIONS="))).toBe(false);
    expect(lines.some((l) => l.startsWith("EMBED_BATCH_SIZE="))).toBe(false);
    expect(lines.some((l) => l.startsWith("EMBED_BATCH_DELAY_MS="))).toBe(false);
  });

  it("renames SCRYBE_TEXT_EMBEDDING_* keys to SCRYBE_KNOWLEDGE_EMBEDDING_*", () => {
    env = makeScenarioEnv();
    seedSchema(env.dataDir);
    writeFileSync(
      join(env.dataDir, ".env"),
      [
        "SCRYBE_TEXT_EMBEDDING_BASE_URL=https://api.voyageai.com/v1",
        "SCRYBE_TEXT_EMBEDDING_API_KEY=text-key",
        "SCRYBE_TEXT_EMBEDDING_MODEL=voyage-large-2",
        "SCRYBE_TEXT_EMBEDDING_DIMENSIONS=1024",
      ].join("\n") + "\n"
    );

    const result = runScrybe(["project", "list"], env);
    expect(result.exit).toBe(0);

    const envContent = readFileSync(join(env.dataDir, ".env"), "utf8");
    expect(envContent).toContain("SCRYBE_KNOWLEDGE_EMBEDDING_BASE_URL=https://api.voyageai.com/v1");
    expect(envContent).toContain("SCRYBE_KNOWLEDGE_EMBEDDING_API_KEY=text-key");
    const lines2 = envContent.split("\n");
    expect(lines2.some((l) => l.startsWith("SCRYBE_TEXT_EMBEDDING_BASE_URL="))).toBe(false);
    expect(lines2.some((l) => l.startsWith("SCRYBE_TEXT_EMBEDDING_API_KEY="))).toBe(false);
  });

  it("migration is idempotent — running twice produces the same .env content", () => {
    env = makeScenarioEnv();
    seedSchema(env.dataDir);
    writeFileSync(
      join(env.dataDir, ".env"),
      "EMBEDDING_BASE_URL=https://api.voyageai.com/v1\nEMBEDDING_API_KEY=key\n"
    );

    // First run — migrates
    runScrybe(["project", "list"], env);
    const afterFirst = readFileSync(join(env.dataDir, ".env"), "utf8");

    // Second run — migration already applied, .env should be unchanged
    runScrybe(["project", "list"], env);
    const afterSecond = readFileSync(join(env.dataDir, ".env"), "utf8");

    // Both runs should produce the same content (idempotent)
    expect(afterSecond).toBe(afterFirst);

    // And the result should use new key names
    expect(afterFirst).toContain("SCRYBE_CODE_EMBEDDING_BASE_URL=");
    const firstLines = afterFirst.split("\n");
    expect(firstLines.some((l) => l.startsWith("EMBEDDING_BASE_URL="))).toBe(false);
  });

  it("logs a warning when OPENAI_API_KEY is the only auth source in .env", () => {
    env = makeScenarioEnv();
    seedSchema(env.dataDir);
    writeFileSync(
      join(env.dataDir, ".env"),
      "OPENAI_API_KEY=sk-openai\nEMBEDDING_BASE_URL=https://api.openai.com/v1\n"
    );

    const result = runScrybe(["project", "list"], env);
    expect(result.exit).toBe(0);

    // Migration warning should appear in stderr
    expect(result.stderr).toContain("OPENAI_API_KEY");
    expect(result.stderr).toContain("SCRYBE_CODE_EMBEDDING_API_KEY");
  });
});
