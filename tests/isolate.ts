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
//
// INVARIANT: this file is process-GLOBAL shared state. globalSetup writes it
// once before any worker starts, and EVERY test file reads it here at
// collection time (module import). It must stay on disk for the whole run.
// A test that deletes it — most easily by importing and calling setup.ts's
// teardown(), which unlinks this path — pulls it out from under every file
// imported afterward. Because vitest.config.ts sets fileParallelism:false,
// those files collect sequentially and fail with a bare ENOENT that points
// here, not at the culprit. If you touch sidecar teardown from a test, back
// this file up and restore it. See tests/setup.ts for the writer/teardown pair.
const SIDECAR_STATE_PATH = join(tmpdir(), "scrybe-test-sidecar.json");
let sidecarRaw: string;
try {
  sidecarRaw = readFileSync(SIDECAR_STATE_PATH, "utf8");
} catch (err) {
  throw new Error(
    `Sidecar state file missing at ${SIDECAR_STATE_PATH}. It is written once by ` +
      `globalSetup (tests/setup.ts) and read by every test file at collection time. ` +
      `A test almost certainly deleted it mid-run (e.g. by calling teardown() or ` +
      `unlinking the shared path). Restore it around any such call. Cause: ${String(err)}`
  );
}
const sidecar = JSON.parse(sidecarRaw) as {
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
