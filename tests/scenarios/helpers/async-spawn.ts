/**
 * Async spawn helper for scenario tests that need concurrent processes.
 * Returns a promise that resolves when the process exits.
 */
import { spawn } from "child_process";
import { ENTRY } from "./spawn.js";
import type { ScenarioEnv } from "./spawn.js";
import { sidecar } from "../../helpers/sidecar.js";

export interface AsyncRunResult {
  stdout: string;
  stderr: string;
  exit: number;
}

export function spawnScrybe(
  args: string[],
  env: ScenarioEnv,
  extra: Record<string, string> = {},
  timeoutMs = 60_000
): Promise<AsyncRunResult> {
  return new Promise((resolve) => {
    const proc = spawn(process.execPath, [ENTRY, ...args], {
      env: {
        ...(process.env as Record<string, string>),
        SCRYBE_DATA_DIR: env.dataDir,
        SCRYBE_DAEMON_PORT: "0",
        SCRYBE_DAEMON_NO_FETCH: "1",
        SCRYBE_SKIP_MIGRATION: "1",
        SCRYBE_NO_AUTO_DAEMON: "1",
        EMBEDDING_BASE_URL: sidecar.baseUrl,
        EMBEDDING_MODEL: sidecar.model,
        EMBEDDING_DIMENSIONS: String(sidecar.dimensions),
        EMBEDDING_API_KEY: "test",
        SCRYBE_HYBRID: "true",
        SCRYBE_RERANK: "false",
        NO_UPDATE_NOTIFIER: "1",
        ...extra,
      },
      stdio: "pipe",
    });

    let stdout = "";
    let stderr = "";
    proc.stdout?.on("data", (d: Buffer) => { stdout += d.toString(); });
    proc.stderr?.on("data", (d: Buffer) => { stderr += d.toString(); });

    const timer = setTimeout(() => {
      proc.kill();
      resolve({ stdout, stderr, exit: 1 });
    }, timeoutMs);

    proc.on("close", (code) => {
      clearTimeout(timer);
      resolve({ stdout, stderr, exit: code ?? 1 });
    });
  });
}
