/**
 * Vitest globalSetup — runs once before all test workers start.
 * Spawns the local embedder sidecar, waits for it to be ready, then writes
 * sidecar connection info to a temp file for per-test helpers to read.
 */
import { spawn, type ChildProcess } from "child_process";
import { writeFileSync, unlinkSync, existsSync } from "fs";
import { join } from "path";
import { tmpdir } from "os";
import { fileURLToPath } from "url";
import { dirname } from "path";

const __dirname = dirname(fileURLToPath(import.meta.url));

export const SIDECAR_STATE_PATH = join(tmpdir(), "scrybe-test-sidecar.json");

let sidecarProcess: ChildProcess | null = null;

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
  const sidecarPath = join(__dirname, "local-embedder.ts");

  // Use node + tsx/esm loader — works cross-platform without needing .cmd wrappers
  sidecarProcess = spawn(
    process.execPath,
    ["--import", "tsx/esm", sidecarPath],
    {
      stdio: ["ignore", "pipe", "pipe"],
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
  if (sidecarProcess) {
    sidecarProcess.kill("SIGTERM");
    sidecarProcess = null;
  }
  if (existsSync(SIDECAR_STATE_PATH)) {
    unlinkSync(SIDECAR_STATE_PATH);
  }
}
