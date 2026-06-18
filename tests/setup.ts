/**
 * Vitest globalSetup — runs once before all test workers start.
 * Spawns the local embedder sidecar, waits for it to be ready, then writes
 * sidecar connection info to a temp file for per-test helpers to read.
 *
 * Sidecar teardown is hardened against crash/SIGKILL of the parent:
 * - Process-group kill on Unix (kill -$pid, the process group).
 * - Signal handlers (SIGINT, SIGTERM, exit) ensure cleanup on failure paths.
 * - On Windows, signal handlers still fire (though no process group).
 */
import { spawn, type ChildProcess } from "child_process";
import { writeFileSync, unlinkSync, existsSync } from "fs";
import { join } from "path";
import { tmpdir } from "os";
import { fileURLToPath } from "url";
import { dirname } from "path";
import { platform } from "os";

const __dirname = dirname(fileURLToPath(import.meta.url));

export const SIDECAR_STATE_PATH = join(tmpdir(), "scrybe-test-sidecar.json");

let sidecarProcess: ChildProcess | null = null;

/**
 * Teardown the sidecar process.
 * On Unix, attempt process-group kill; fallback to direct SIGTERM.
 * On Windows, use direct kill.
 */
function teardownSidecar(): void {
  if (!sidecarProcess) return;

  try {
    const pid = sidecarProcess.pid;
    if (pid === undefined) return;

    // Unix: attempt process-group kill (pid passed as negative).
    // This ensures any subprocesses spawned by the sidecar are also killed.
    if (platform() !== "win32") {
      try {
        process.kill(-pid);
        return;
      } catch {
        // If process-group kill fails (e.g., process already dead), fall through.
      }
    }

    // Fallback: direct SIGTERM.
    sidecarProcess.kill("SIGTERM");
  } catch {
    // Process already dead or kill failed; ignore.
  }

  sidecarProcess = null;
}

async function pollHealth(baseUrl: string, timeoutMs: number): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const resp = await fetch(`${baseUrl.replace(/\/v1$/, "")}/health`);
      if (resp.ok) {
        const body = await resp.json() as { ready: boolean };
        if (body.ready) return;
      }
    } catch {
      // not ready yet
    }
    await new Promise((r) => setTimeout(r, 200));
  }
  throw new Error("Local embedder sidecar did not become ready within timeout");
}

export async function setup(): Promise<void> {
  // Pre-build the multi-branch fixture once, before workers start.
  // Avoids concurrent git operations on the same fixture dir on Windows.
  const { ensureMultiBranchFixture } = await import("./helpers/fixtures.js");
  ensureMultiBranchFixture("sample-multi-branch-repo");

  const sidecarPath = join(__dirname, "local-embedder.ts");

  // Use node + tsx/esm loader — works cross-platform without needing .cmd wrappers
  // Spawn in its own process group on Unix (detached: true creates a process group);
  // on Windows, detached: true still isolates from parent but doesn't form a process group.
  sidecarProcess = spawn(
    process.execPath,
    ["--import", "tsx/esm", sidecarPath],
    {
      stdio: ["ignore", "pipe", "pipe"],
      detached: platform() !== "win32", // Unix: start in new process group
      env: {
        ...process.env,
        SCRYBE_SIDECAR_INJECT_429: "0",
      },
    }
  );

  const portInfo = await new Promise<{ port: number; baseUrl: string }>((resolve, reject) => {
    let buf = "";
    sidecarProcess!.stdout!.on("data", (chunk: Buffer) => {
      buf += chunk.toString();
      const newline = buf.indexOf("\n");
      if (newline !== -1) {
        const line = buf.slice(0, newline).trim();
        try {
          resolve(JSON.parse(line));
        } catch (e) {
          reject(new Error(`Bad sidecar stdout: ${line}`));
        }
      }
    });
    sidecarProcess!.stderr!.on("data", (chunk: Buffer) => {
      process.stderr.write(`[sidecar] ${chunk}`);
    });
    sidecarProcess!.on("exit", (code) => {
      reject(new Error(`Sidecar exited early with code ${code}`));
    });
    setTimeout(() => reject(new Error("Sidecar startup timeout (no stdout)")), 30_000);
  });

  await pollHealth(portInfo.baseUrl, 60_000);

  writeFileSync(
    SIDECAR_STATE_PATH,
    JSON.stringify({ baseUrl: portInfo.baseUrl, dimensions: 384, model: "Xenova/all-MiniLM-L6-v2" })
  );
}

export async function teardown(): Promise<void> {
  teardownSidecar();
  if (existsSync(SIDECAR_STATE_PATH)) {
    unlinkSync(SIDECAR_STATE_PATH);
  }
}

// Register signal handlers so teardown runs even if the process is killed.
// These run on SIGINT (Ctrl+C), SIGTERM (graceful shutdown), and exit (clean exit).
process.on("SIGINT", () => {
  teardownSidecar();
  process.exit(0);
});

process.on("SIGTERM", () => {
  teardownSidecar();
  process.exit(0);
});

process.on("exit", () => {
  teardownSidecar();
});
