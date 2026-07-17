/**
 * Plan 102 — post-install.js dev-checkout guard.
 *
 * `isDevCheckout(pkgRoot)` (D1) makes postinstall a no-op whenever `.git` exists at pkgRoot —
 * a clone, a worktree, CI — so `npm install` in a scrybe checkout never spawns a daemon
 * pointed at the shared data dir. `SCRYBE_HOOK_ASSUME_INSTALL=1` (D4) forces the pre-Plan-102
 * behavior for our own test harness, which necessarily invokes the hook from inside this repo
 * (pkgRoot = repo root, which always has `.git`).
 *
 * Three cases:
 *  1. `.git` present at pkgRoot, no escape hatch → no-op (no spawn).
 *  2. `.git` absent (temp pkgRoot fixture) → behaves as today (spawns).
 *  3. `.git` present + SCRYBE_HOOK_ASSUME_INSTALL=1 → behaves as today (spawns).
 */
import { describe, it, expect, afterEach } from "vitest";
import { spawnSync } from "child_process";
import { existsSync, readFileSync, mkdirSync } from "fs";
import { join } from "path";
import { makeScenarioEnv, type ScenarioEnv } from "./helpers/spawn.js";
import { makeDevCheckoutFreePkgRoot, type HookFixture } from "./helpers/hook-fixture.js";
import { sidecar } from "../helpers/sidecar.js";

const NODE = process.execPath;
const POST_INSTALL = join(process.cwd(), "npm-hooks/post-install.js");

let env: ScenarioEnv | null = null;
let fixture: HookFixture | null = null;
let spawnedDaemonPid: number | null = null;

async function waitFor(check: () => boolean | Promise<boolean>, timeoutMs: number): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try { if (await check()) return true; } catch { /* ignore */ }
    await new Promise((r) => setTimeout(r, 300));
  }
  return false;
}

function isPidAlive(pid: number): boolean {
  try { process.kill(pid, 0); return true; } catch { return false; }
}

function killDaemon(pid: number): void {
  try { process.kill(pid, "SIGTERM"); } catch { /* already gone */ }
}

afterEach(async () => {
  if (spawnedDaemonPid && isPidAlive(spawnedDaemonPid)) {
    killDaemon(spawnedDaemonPid);
    const deadline = Date.now() + 3000;
    while (Date.now() < deadline && isPidAlive(spawnedDaemonPid)) {
      await new Promise((r) => setTimeout(r, 200));
    }
    spawnedDaemonPid = null;
  }
  env?.cleanup(); env = null;
  fixture?.cleanup(); fixture = null;
});

function runPostInstall(
  hookPath: string,
  dataDir: string,
  extraEnv: Record<string, string> = {}
): { exit: number; stdout: string; stderr: string } {
  const result = spawnSync(NODE, [hookPath], {
    env: {
      ...(process.env as Record<string, string>),
      SCRYBE_DATA_DIR: dataDir,
      SCRYBE_DAEMON_PORT: "0",
      SCRYBE_SKIP_MIGRATION: "1",
      SCRYBE_CODE_EMBEDDING_BASE_URL: sidecar.baseUrl,
      SCRYBE_CODE_EMBEDDING_MODEL: sidecar.model,
      SCRYBE_CODE_EMBEDDING_DIMENSIONS: String(sidecar.dimensions),
      SCRYBE_CODE_EMBEDDING_API_KEY: "test",
      NO_UPDATE_NOTIFIER: "1",
      ...extraEnv,
    },
    encoding: "utf8",
    timeout: 15_000,
  });
  return {
    exit: result.status ?? 1,
    stdout: result.stdout ?? "",
    stderr: result.stderr ?? "",
  };
}

async function expectPidfileAppears(dataDir: string): Promise<void> {
  const pidfilePath = join(dataDir, "daemon.pid");
  const appeared = await waitFor(() => {
    if (!existsSync(pidfilePath)) return false;
    try {
      const d = JSON.parse(readFileSync(pidfilePath, "utf8")) as { port?: number; pid?: number };
      return (d.port ?? 0) > 0 && (d.pid ?? 0) > 0;
    } catch { return false; }
  }, 10_000);
  expect(appeared).toBe(true);
  try {
    const d = JSON.parse(readFileSync(pidfilePath, "utf8")) as { pid: number };
    spawnedDaemonPid = d.pid;
  } catch { /* ok */ }
}

describe("Plan 102 — postinstall dev-checkout guard", () => {
  it("case 1: .git present at pkgRoot, no escape hatch → no-op (no spawn)", () => {
    env = makeScenarioEnv();
    mkdirSync(env.dataDir, { recursive: true });

    // POST_INSTALL resolves pkgRoot to this repo's root, which has `.git`.
    const result = runPostInstall(POST_INSTALL, env.dataDir);

    expect(result.exit).toBe(0);
    expect(existsSync(join(env.dataDir, "daemon.pid"))).toBe(false);
  });

  it("case 2: .git absent (temp pkgRoot fixture) → behaves as today (spawns)", async () => {
    env = makeScenarioEnv();
    mkdirSync(env.dataDir, { recursive: true });
    fixture = makeDevCheckoutFreePkgRoot("post-install.js", true);

    const result = runPostInstall(fixture.hookPath, env.dataDir);
    expect(result.exit).toBe(0);

    await expectPidfileAppears(env.dataDir);
  }, 20_000);

  it("case 3: .git present + SCRYBE_HOOK_ASSUME_INSTALL=1 → behaves as today (spawns)", async () => {
    env = makeScenarioEnv();
    mkdirSync(env.dataDir, { recursive: true });

    const result = runPostInstall(POST_INSTALL, env.dataDir, { SCRYBE_HOOK_ASSUME_INSTALL: "1" });
    expect(result.exit).toBe(0);

    await expectPidfileAppears(env.dataDir);
  }, 20_000);
});
