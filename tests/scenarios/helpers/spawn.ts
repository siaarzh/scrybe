/**
 * Scenario harness — spawn helper.
 * Runs the real built binary (`node dist/index.js`) against an isolated DATA_DIR.
 * Mirror of tests/helpers/daemon.ts env-wiring pattern.
 */
import { spawnSync } from "child_process";
import { mkdtempSync, rmSync } from "fs";
import { join } from "path";
import { tmpdir } from "os";
import { sidecar } from "../../helpers/sidecar.js";

const NODE = process.execPath;
export const ENTRY = join(process.cwd(), "dist/index.js");

export interface RunResult {
  stdout: string;
  stderr: string;
  exit: number;
}

export interface ScenarioEnv {
  dataDir: string;
  cleanup(): void;
}

/** Create an isolated DATA_DIR for a scenario. Call cleanup() in afterEach. */
export function makeScenarioEnv(): ScenarioEnv {
  const dataDir = mkdtempSync(join(tmpdir(), "scrybe-scenario-"));
  return {
    dataDir,
    cleanup() {
      try { rmSync(dataDir, { recursive: true, force: true }); } catch { /* ignore */ }
    },
  };
}

/** Run the built binary synchronously. Returns { stdout, stderr, exit }. */
export function runScrybe(
  args: string[],
  env: ScenarioEnv,
  extra: Record<string, string> = {},
  timeoutMs = 30_000
): RunResult {
  const result = spawnSync(NODE, [ENTRY, ...args], {
    env: {
      ...(process.env as Record<string, string>),
      SCRYBE_DATA_DIR: env.dataDir,
      SCRYBE_DAEMON_PORT: "0",
      SCRYBE_DAEMON_NO_FETCH: "1",
      SCRYBE_SKIP_MIGRATION: "1",
      // Prevent scrybe index / gc from spawning a background daemon in scenario tests.
      // Tests that specifically need daemon routing (e.g. two-writer-race) override this.
      SCRYBE_NO_AUTO_DAEMON: "1",
      // Wire sidecar embedder so index commands embed without API keys
      SCRYBE_CODE_EMBEDDING_BASE_URL: sidecar.baseUrl,
      SCRYBE_CODE_EMBEDDING_MODEL: sidecar.model,
      SCRYBE_CODE_EMBEDDING_DIMENSIONS: String(sidecar.dimensions),
      SCRYBE_CODE_EMBEDDING_API_KEY: "test",
      SCRYBE_HYBRID: "true",
      SCRYBE_RERANK: "false",
      NO_UPDATE_NOTIFIER: "1",
      ...extra,
    },
    encoding: "utf8",
    timeout: timeoutMs,
  });

  return {
    stdout: result.stdout ?? "",
    stderr: result.stderr ?? "",
    exit: result.status ?? 1,
  };
}

/** Run with stdin piped (for prompts that read from stdin). */
export function runScrybeWithStdin(
  args: string[],
  stdin: string,
  env: ScenarioEnv,
  extra: Record<string, string> = {},
  timeoutMs = 30_000
): RunResult {
  const result = spawnSync(NODE, [ENTRY, ...args], {
    env: {
      ...(process.env as Record<string, string>),
      SCRYBE_DATA_DIR: env.dataDir,
      SCRYBE_DAEMON_PORT: "0",
      SCRYBE_DAEMON_NO_FETCH: "1",
      SCRYBE_SKIP_MIGRATION: "1",
      SCRYBE_NO_AUTO_DAEMON: "1",
      SCRYBE_CODE_EMBEDDING_BASE_URL: sidecar.baseUrl,
      SCRYBE_CODE_EMBEDDING_MODEL: sidecar.model,
      SCRYBE_CODE_EMBEDDING_DIMENSIONS: String(sidecar.dimensions),
      SCRYBE_CODE_EMBEDDING_API_KEY: "test",
      SCRYBE_HYBRID: "true",
      SCRYBE_RERANK: "false",
      NO_UPDATE_NOTIFIER: "1",
      ...extra,
    },
    input: stdin,
    encoding: "utf8",
    timeout: timeoutMs,
  });

  return {
    stdout: result.stdout ?? "",
    stderr: result.stderr ?? "",
    exit: result.status ?? 1,
  };
}
