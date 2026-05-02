/**
 * Vitest setupFiles — runs in each test file's module context.
 * Sets env vars and resets module registry before each test so that
 * config.ts picks up the correct DATA_DIR and embedding config per test.
 */
import { beforeEach, afterEach, vi } from "vitest";
import { mkdtempSync, rmSync, readFileSync } from "fs";
import { join } from "path";
import { tmpdir } from "os";

// Read sidecar connection info written by globalSetup (tests/setup.ts).
// This file exists by the time setupFiles run.
const SIDECAR_STATE_PATH = join(tmpdir(), "scrybe-test-sidecar.json");
const sidecar = JSON.parse(readFileSync(SIDECAR_STATE_PATH, "utf8")) as {
  baseUrl: string;
  dimensions: number;
  model: string;
};

let testDir = "";

beforeEach(() => {
  testDir = mkdtempSync(join(tmpdir(), "scrybe-test-"));
  process.env["SCRYBE_DATA_DIR"] = testDir;
  // SCRYBE_CODE_EMBEDDING_* are what src/config.ts reads
  process.env["SCRYBE_CODE_EMBEDDING_BASE_URL"] = sidecar.baseUrl;
  process.env["SCRYBE_CODE_EMBEDDING_MODEL"] = sidecar.model;
  process.env["SCRYBE_CODE_EMBEDDING_DIMENSIONS"] = String(sidecar.dimensions);
  process.env["SCRYBE_CODE_EMBEDDING_API_KEY"] = "test";
  process.env["SCRYBE_HYBRID"] = "true";
  // Disable reranking in tests — it requires Voyage and would fail without credentials
  process.env["SCRYBE_RERANK"] = "false";
  // Clear module cache so config.ts is re-evaluated with fresh env vars
  vi.resetModules();
});

afterEach(async () => {
  // Close SQLite branch-state handle before module reset nukes it
  try {
    const { closeDB } = await import("../src/branch-state.js");
    closeDB();
  } catch {
    // module not yet loaded in this test — no-op
  }

  // Brief pause to let LanceDB release file handles (especially on Windows)
  await new Promise((r) => setTimeout(r, 100));
  if (testDir) {
    try {
      rmSync(testDir, { recursive: true, force: true });
    } catch {
      // Windows EBUSY — retry once after brief wait
      await new Promise((r) => setTimeout(r, 500));
      try {
        rmSync(testDir, { recursive: true, force: true });
      } catch {
        // ignore — OS will clean up on reboot
      }
    }
    testDir = "";
  }
});

export { sidecar };
