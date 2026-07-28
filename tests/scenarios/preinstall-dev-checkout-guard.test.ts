/**
 * Plan 102 — pre-install.js dev-checkout guard.
 *
 * `isDevCheckout(pkgRoot)` (D1) makes preinstall a no-op whenever `.git` exists at pkgRoot —
 * a clone, a worktree, CI — so `npm install` in a scrybe checkout never stops the user's
 * shared daemon (D2: the unconditional stop is its own harm, independent of postinstall).
 * `SCRYBE_HOOK_ASSUME_INSTALL=1` (D4) forces the pre-Plan-102 behavior for our own test
 * harness, which necessarily invokes the hook from inside this repo (pkgRoot = repo root,
 * which always has `.git`).
 *
 * Three cases:
 *  1. `.git` present at pkgRoot, no escape hatch → no-op (daemon stays alive).
 *  2. `.git` absent (temp pkgRoot fixture) → behaves as today (stops the daemon).
 *  3. `.git` present + SCRYBE_HOOK_ASSUME_INSTALL=1 → behaves as today (stops the daemon).
 */
import { describe, it, expect, afterEach } from "vitest";
import { spawn, spawnSync } from "child_process";
import { existsSync, readFileSync } from "fs";
import { join } from "path";
import { makeScenarioEnv, ENTRY, type ScenarioEnv } from "./helpers/spawn.js";
import { makeDevCheckoutFreePkgRoot, type HookFixture } from "./helpers/hook-fixture.js";
import { sidecar } from "../helpers/sidecar.js";

const NODE = process.execPath;
const PRE_INSTALL = join(process.cwd(), "npm-hooks/pre-install.js");

let env: ScenarioEnv | null = null;
let fixture: HookFixture | null = null;
let daemonProcess: ReturnType<typeof spawn> | null = null;

async function waitFor(check: () => boolean | Promise<boolean>, timeoutMs: number): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await check()) return;
    await new Promise((r) => setTimeout(r, 200));
  }
  throw new Error(`waitFor timed out after ${timeoutMs}ms`);
}

function daemonEnv(dataDir: string): Record<string, string> {
  return {
    ...(process.env as Record<string, string>),
    SCRYBE_DATA_DIR: dataDir,
    SCRYBE_DAEMON_PORT: "0",
    SCRYBE_DAEMON_NO_FETCH: "1",
    SCRYBE_SKIP_MIGRATION: "1",
    SCRYBE_CODE_EMBEDDING_BASE_URL: sidecar.baseUrl,
    SCRYBE_CODE_EMBEDDING_MODEL: sidecar.model,
    SCRYBE_CODE_EMBEDDING_DIMENSIONS: String(sidecar.dimensions),
    SCRYBE_CODE_EMBEDDING_API_KEY: "test",
    SCRYBE_HYBRID: "true",
    SCRYBE_RERANK: "false",
    NO_UPDATE_NOTIFIER: "1",
  };
}

async function startDaemon(dataDir: string): Promise<{ pid: number; port: number }> {
  const pidfilePath = join(dataDir, "daemon.pid");
  const child = spawn(NODE, [ENTRY, "daemon", "start"], {
    env: daemonEnv(dataDir),
    stdio: "ignore",
    detached: false,
  });
  daemonProcess = child;

  await waitFor(() => {
    if (!existsSync(pidfilePath)) return false;
    try {
      const d = JSON.parse(readFileSync(pidfilePath, "utf8")) as { port?: number };
      return (d.port ?? 0) > 0;
    } catch { return false; }
  }, 10_000);

  const pidData = JSON.parse(readFileSync(pidfilePath, "utf8")) as { pid: number; port: number };
  return { pid: pidData.pid, port: pidData.port };
}

afterEach(() => {
  if (daemonProcess && !daemonProcess.killed) { daemonProcess.kill(); daemonProcess = null; }
  env?.cleanup(); env = null;
  fixture?.cleanup(); fixture = null;
});

/**
 * Run the preinstall hook WITHOUT blocking this process's event loop.
 *
 * Deliberately async, NOT spawnSync — same trap as tests/sigterm-escalation.test.ts
 * documents. The daemon under test is a child of THIS vitest process, so when it
 * exits it becomes a zombie until vitest reaps it. spawnSync blocks the event
 * loop for the whole hook run, so the reap never happens, `process.kill(pid, 0)`
 * keeps succeeding on the zombie, and the hook's waitForExit never sees it die —
 * it burns its full escalation budget (POST /shutdown + 5s + SIGTERM + 5s +
 * SIGTERM + 10s = 22s) and blows the harness timeout.
 *
 * That is a harness artifact, not product behaviour: in a real install the
 * daemon is detached and reparented to init, which reaps it immediately. Timed
 * directly against a live daemon, this hook returns in ~300ms.
 */
function runPreinstall(
  hookPath: string,
  dataDir: string,
  extraEnv: Record<string, string> = {}
): Promise<{ stdout: string; stderr: string; exit: number }> {
  return new Promise((resolve, reject) => {
    const child = spawn(NODE, [hookPath], {
      env: {
        ...(process.env as Record<string, string>),
        SCRYBE_DATA_DIR: dataDir,
        ...extraEnv,
      },
      stdio: ["ignore", "pipe", "pipe"],
      windowsHide: true,
    });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (c) => { stdout += c.toString(); });
    child.stderr.on("data", (c) => { stderr += c.toString(); });
    const timer = setTimeout(() => { try { child.kill("SIGKILL"); } catch { /* ignore */ } }, 25_000);
    child.once("error", (err) => { clearTimeout(timer); reject(err); });
    child.once("exit", (code) => { clearTimeout(timer); resolve({ stdout, stderr, exit: code ?? 1 }); });
  });
}

function isPidAlive(pid: number): boolean {
  try { process.kill(pid, 0); return true; } catch { return false; }
}

describe("Plan 102 — preinstall dev-checkout guard", () => {
  it("case 1: .git present at pkgRoot, no escape hatch → no-op (daemon stays alive)", async () => {
    env = makeScenarioEnv();
    const daemon = await startDaemon(env.dataDir);
    expect(isPidAlive(daemon.pid)).toBe(true);

    // PRE_INSTALL resolves pkgRoot to this repo's root, which has `.git`.
    const result = await runPreinstall(PRE_INSTALL, env.dataDir);

    expect(result.exit).toBe(0);
    expect(result.stdout).not.toContain("[scrybe preinstall]");
    expect(isPidAlive(daemon.pid)).toBe(true);
  }, 20_000);

  it("case 2: .git absent (temp pkgRoot fixture) → behaves as today (stops the daemon)", async () => {
    env = makeScenarioEnv();
    fixture = makeDevCheckoutFreePkgRoot("pre-install.js", false);
    const daemon = await startDaemon(env.dataDir);
    expect(isPidAlive(daemon.pid)).toBe(true);

    const result = await runPreinstall(fixture.hookPath, env.dataDir);

    expect(result.exit).toBe(0);
    expect(result.stdout).toContain("[scrybe preinstall]");
    expect(result.stdout).toContain(`pid=${daemon.pid}`);

    await new Promise((r) => setTimeout(r, 500));
    expect(isPidAlive(daemon.pid)).toBe(false);
    daemonProcess = null; // already stopped
  }, 30_000);

  it("case 3: .git present + SCRYBE_HOOK_ASSUME_INSTALL=1 → behaves as today (stops the daemon)", async () => {
    env = makeScenarioEnv();
    const daemon = await startDaemon(env.dataDir);
    expect(isPidAlive(daemon.pid)).toBe(true);

    const result = await runPreinstall(PRE_INSTALL, env.dataDir, { SCRYBE_HOOK_ASSUME_INSTALL: "1" });

    expect(result.exit).toBe(0);
    expect(result.stdout).toContain("[scrybe preinstall]");
    expect(result.stdout).toContain(`pid=${daemon.pid}`);

    await new Promise((r) => setTimeout(r, 500));
    expect(isPidAlive(daemon.pid)).toBe(false);
    daemonProcess = null; // already stopped
  }, 30_000);
});
