/**
 * Plan 108 — the three STOP INVARIANTS.
 *
 * WHY THIS FILE EXISTS (read before changing anything in it).
 *
 * `daemon stop` oscillated across three rounds of work, each round fixing the
 * previous one and breaking the one before that:
 *
 *   original  — force-unlinks the pidfile at 5 s, prints "Daemon stopped."
 *               → it LIES; the pidfile is removed under a live daemon.
 *   round 1   — escalate at 5 s so the claim becomes true
 *               → DESTROYS the documented 30-minute drain, aborting reindexes
 *                 mid-write.
 *   round 2   — escalation becomes opt-in via `--force`
 *               → honest, but `stop` no longer stops, and callers leak live
 *                 daemons (one reached 6.9 GB RSS in 74 s).
 *
 * Root cause of the oscillation: every fix spec was derived from a REVIEW
 * FINDINGS LIST. A findings list enumerates what is wrong *now* and carries no
 * memory of what was previously made right, and blind reviewers are stateless
 * by design — they cannot flag a reversal they never saw. The 30-minute drain
 * had already been locked in prose, in the plan file and in queue.json, and
 * round 1 destroyed it anyway.
 *
 * PROSE DOES NOT BIND. This file does.
 *
 * Each invariant below is asserted in BOTH DIRECTIONS, so that satisfying one
 * by reversing another turns the suite red instead of shipping. That is the
 * whole point — do not "simplify" a test here by dropping its opposite half.
 *
 *   1. A stop request must not abort in-flight work before the drain budget…
 *      …but `--force` must still abandon it promptly.
 *   2. After `daemon stop` returns, the daemon is gone — or the caller can
 *      DETECT that it is not, without parsing prose.
 *   3. The pidfile is never unlinked under a live pid…
 *      …but it is always gone once the daemon is confirmed dead.
 *
 * These are deliberately written against the CLI surface, not against
 * `stopDaemonGracefully()` internals: the callers that actually leaked live
 * daemons (test teardown, npm hooks, CI scripts) are shell callers, and an
 * invariant that only holds for a TypeScript caller would not have caught the
 * incident this file exists to prevent. They are also independent of HOW the
 * locks are implemented, so they survive the SQLite lock rewrite unchanged.
 *
 * Test-safety notes (this suite spawns REAL daemons):
 *   - scratch SCRYBE_DATA_DIR under the OS temp dir, never the real one;
 *   - the indexed corpus is a small purpose-built temp repo, NEVER
 *     `process.cwd()` — a source rooted at the repo pulls in node_modules and
 *     is exactly how a test daemon reached 6.9 GB;
 *   - every child is SIGKILLed in afterEach even if an assertion threw.
 */
import { describe, it, expect, afterEach } from "vitest";
import { spawn, spawnSync } from "child_process";
import { existsSync, readFileSync, mkdtempSync, rmSync } from "fs";
import { join } from "path";
import { tmpdir, platform } from "os";
import { makeTempRepo, type TempRepo } from "./scenarios/helpers/repo.js";

const NODE = process.execPath;
const ENTRY = join(process.cwd(), "dist/index.js");

/** Inherit the populated model cache when the environment provides one (review F13). */
const INHERITED_MODEL_CACHE_DIR = process.env["SCRYBE_MODEL_CACHE_DIR"];

/**
 * `child.kill("SIGTERM")` is not catchable on Windows — Node maps it to
 * TerminateProcess, so a daemon dies on the first signal and "still draining"
 * is unobservable. Same gate as tests/sigterm-escalation.test.ts.
 */
const describeSignals = platform() === "win32" ? describe.skip : describe;

/**
 * How long the daemon's single write batch is held open, to guarantee there is
 * genuine in-flight work while we stop it. Must comfortably exceed
 * `stopDaemonGracefully`'s 5 s first wait, or the daemon finishes on its own
 * and every assertion below becomes vacuous.
 */
const WRITE_DELAY_MS = 20_000;

interface PidfileData { pid: number; port: number }

function readPidfile(pidfilePath: string): PidfileData | null {
  if (!existsSync(pidfilePath)) return null;
  try {
    return JSON.parse(readFileSync(pidfilePath, "utf8")) as PidfileData;
  } catch {
    return null;
  }
}

function isAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

async function waitUntil(
  check: () => Promise<boolean> | boolean,
  timeoutMs = 15_000,
  intervalMs = 100,
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await check()) return;
    await new Promise((r) => setTimeout(r, intervalMs));
  }
  throw new Error("waitUntil timed out");
}

/** Run a CLI command as a real child without blocking this process's event loop. */
function runCliAsync(
  args: string[],
  env: NodeJS.ProcessEnv,
  timeoutMs: number,
): Promise<{ status: number | null; stdout: string; stderr: string }> {
  return new Promise((resolve, reject) => {
    const child = spawn(NODE, args, { env, stdio: ["ignore", "pipe", "pipe"], windowsHide: true });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (c) => { stdout += c.toString(); });
    child.stderr.on("data", (c) => { stderr += c.toString(); });
    const timer = setTimeout(() => { try { child.kill("SIGKILL"); } catch { /* ignore */ } }, timeoutMs);
    child.once("error", (err) => { clearTimeout(timer); reject(err); });
    child.once("exit", (code) => { clearTimeout(timer); resolve({ status: code, stdout, stderr }); });
  });
}

const activeDataDirs: string[] = [];
const activeChildren: ReturnType<typeof spawn>[] = [];
const activePids: number[] = [];
let repo: TempRepo | null = null;

afterEach(() => {
  for (const c of activeChildren) {
    if (!c.killed) { try { c.kill("SIGKILL"); } catch { /* ignore */ } }
  }
  activeChildren.length = 0;
  // Belt and braces: a daemon that outlived its spawn handle (or was respawned)
  // must not survive this file. A leaked daemon here indexes on unbounded.
  for (const pid of activePids) {
    try { process.kill(pid, "SIGKILL"); } catch { /* already gone */ }
  }
  activePids.length = 0;
  for (const dir of activeDataDirs) {
    try { rmSync(dir, { recursive: true, force: true }); } catch { /* ignore */ }
  }
  activeDataDirs.length = 0;
  repo?.cleanup();
  repo = null;
});

interface BootedDaemon {
  child: ReturnType<typeof spawn>;
  pid: number;
  dataDir: string;
  pidfilePath: string;
  baseUrl: string;
  cliEnv: NodeJS.ProcessEnv;
  getExitState: () => { exited: boolean; code: number | null };
  activeJobCount: () => Promise<number>;
}

/**
 * Boot a real daemon against a scratch data dir with a REAL reindex job in
 * flight, confirmed active via GET /status before returning. The corpus is a
 * purpose-built temp repo — deliberately not `process.cwd()`.
 */
async function bootDaemonWithActiveJob(projectId: string): Promise<BootedDaemon> {
  const files: Record<string, string> = {};
  for (let i = 0; i < 40; i++) {
    files[`src/file${i}.ts`] = `export function fn${i}(x: number): number {\n  return x + ${i};\n}\n`.repeat(20);
  }
  repo = makeTempRepo(files);

  const dataDir = mkdtempSync(join(tmpdir(), "scrybe-stop-invariants-"));
  activeDataDirs.push(dataDir);
  const pidfilePath = join(dataDir, "daemon.pid");

  const daemonEnv = {
    ...process.env,
    SCRYBE_DATA_DIR: dataDir,
    SCRYBE_SKIP_MIGRATION: "1",
    SCRYBE_DAEMON_PORT: "0",
    ...(INHERITED_MODEL_CACHE_DIR ? { SCRYBE_MODEL_CACHE_DIR: INHERITED_MODEL_CACHE_DIR } : {}),
    SCRYBE_TEST_WRITE_DELAY_MS: String(WRITE_DELAY_MS),
  };

  const child = spawn(NODE, [ENTRY, "daemon", "start"], {
    env: daemonEnv, stdio: "ignore", detached: false, windowsHide: true,
  });
  activeChildren.push(child);

  let exited = false;
  let exitCode: number | null = null;
  child.once("exit", (code) => { exited = true; exitCode = code; });

  await waitUntil(() => {
    const d = readPidfile(pidfilePath);
    return !!d && d.port > 0;
  }, 20_000);

  const { pid, port } = readPidfile(pidfilePath)!;
  activePids.push(pid);
  const baseUrl = `http://127.0.0.1:${port}`;
  await waitUntil(async () => {
    try { return (await fetch(`${baseUrl}/health`)).ok; } catch { return false; }
  }, 10_000);

  const cliEnv = { ...process.env, SCRYBE_DATA_DIR: dataDir, SCRYBE_SKIP_MIGRATION: "1" };
  const addProject = spawnSync(NODE, [ENTRY, "project", "add", "--id", projectId], {
    env: cliEnv, encoding: "utf8", timeout: 15_000, windowsHide: true,
  });
  expect(addProject.status, addProject.stderr).toBe(0);

  // `source add` auto-enqueues a real reindex job against the running daemon.
  const addSource = spawnSync(NODE, [
    ENTRY, "source", "add", "-P", projectId, "-S", "primary",
    "--type", "code", "--root", repo.path, "--languages", "ts",
  ], { env: cliEnv, encoding: "utf8", timeout: 20_000, windowsHide: true });
  expect(addSource.status, addSource.stderr).toBe(0);

  const activeJobCount = async (): Promise<number> => {
    try {
      const data = await (await fetch(`${baseUrl}/status`)).json() as { queue?: { active?: number } };
      return data.queue?.active ?? 0;
    } catch {
      return 0;
    }
  };

  await waitUntil(async () => (await activeJobCount()) >= 1, 10_000);

  return {
    child, pid, dataDir, pidfilePath, baseUrl, cliEnv,
    getExitState: () => ({ exited, code: exitCode }),
    activeJobCount,
  };
}

describeSignals("Plan 108 — stop invariants", () => {
  /**
   * INVARIANT 1 — the drain budget is real.
   *
   * Direction A: a plain `daemon stop` against a daemon with an active reindex
   * must NOT kill it. Violated by review round 1 (F2), which escalated at 5 s
   * and aborted genuine reindexes mid-write.
   *
   * Direction B: `daemon stop --force` MUST abandon the drain promptly.
   * Without this half, "never abort in-flight work" could be satisfied by
   * simply never escalating at all — which is round 2's failure mode.
   */
  it("direction A: a plain stop does not abort an in-flight reindex", async () => {
    const d = await bootDaemonWithActiveJob("stop-inv-drain");

    expect(await d.activeJobCount(), "precondition: a job must be in flight").toBeGreaterThanOrEqual(1);

    await runCliAsync([ENTRY, "daemon", "stop"], d.cliEnv, 30_000);

    // stopDaemonGracefully waits 5 s before reporting; the write delay is 20 s,
    // so an alive daemon here means the drain was genuinely honoured rather
    // than the job having simply finished.
    expect(
      d.getExitState().exited,
      "a plain `daemon stop` aborted an in-flight reindex — the documented drain budget was destroyed (round 1's regression)",
    ).toBe(false);
    expect(isAlive(d.pid)).toBe(true);
  }, 90_000);

  it("direction B: --force abandons the drain promptly", async () => {
    const d = await bootDaemonWithActiveJob("stop-inv-force");

    expect(await d.activeJobCount(), "precondition: a job must be in flight").toBeGreaterThanOrEqual(1);

    const t0 = Date.now();
    await runCliAsync([ENTRY, "daemon", "stop", "--force"], d.cliEnv, 40_000);
    const elapsedMs = Date.now() - t0;

    await waitUntil(() => d.getExitState().exited, 5_000, 50);
    expect(
      d.getExitState().exited,
      "`daemon stop --force` left the daemon alive — the escape hatch from the drain is gone",
    ).toBe(true);
    // Well under the 20 s write delay: it escalated rather than waiting the job out.
    expect(elapsedMs).toBeLessThan(WRITE_DELAY_MS);
  }, 90_000);

  /**
   * INVARIANT 2 — a stop that did not stop must be DETECTABLE.
   *
   * The daemon may legitimately outlive the request (that is invariant 1), but
   * the caller must be able to tell the two outcomes apart. Shell callers are
   * the ones that leaked live daemons, and a shell caller only sees the exit
   * code: `scrybe daemon stop && next-thing` is the universal idiom, and today
   * both "stopped" and "still draining" exit 0, so the idiom silently proceeds
   * with a live daemon behind it. That is precisely how a test daemon reached
   * 6.9 GB RSS in 74 s while its harness believed it had stopped it.
   *
   * This test deliberately does NOT prescribe WHICH exit code means "still
   * draining" — only that the two outcomes are distinguishable without parsing
   * human-readable prose. Picking the code is a user-facing contract decision,
   * not something a test should smuggle in.
   */
  it("a stop that leaves the daemon alive is distinguishable from one that stopped it", async () => {
    // Outcome 1: daemon still draining after the stop returns.
    const draining = await bootDaemonWithActiveJob("stop-inv-detect-a");
    const drainingResult = await runCliAsync([ENTRY, "daemon", "stop"], draining.cliEnv, 30_000);
    expect(draining.getExitState().exited, "precondition: this arm needs a daemon that survived the stop").toBe(false);

    // Outcome 2: daemon genuinely stopped. Same command, same surface.
    const stopped = await bootDaemonWithActiveJob("stop-inv-detect-b");
    const stoppedResult = await runCliAsync([ENTRY, "daemon", "stop", "--force"], stopped.cliEnv, 40_000);
    await waitUntil(() => stopped.getExitState().exited, 5_000, 50);
    expect(stopped.getExitState().exited, "precondition: this arm needs a daemon that actually stopped").toBe(true);

    expect(
      drainingResult.status,
      "`daemon stop` reports the SAME exit status whether or not the daemon is gone, so a shell caller " +
      "(`scrybe daemon stop && …`) cannot tell that it is about to proceed with a live daemon behind it. " +
      `still-draining exited ${drainingResult.status}, confirmed-stopped exited ${stoppedResult.status}.`,
    ).not.toBe(stoppedResult.status);
  }, 150_000);

  /**
   * INVARIANT 3 — the pidfile tracks reality.
   *
   * Direction A: never unlinked under a live pid. Violated by the ORIGINAL
   * implementation, which force-unlinked at 5 s. A pidfile removed under a
   * live daemon is worse than a stale one: the next `ensureRunning()` sees no
   * daemon, spawns one, and that one contends with a daemon nobody can find.
   *
   * Direction B: gone once the daemon is confirmed dead. Without this half,
   * "never unlink under a live pid" is trivially satisfied by never cleaning
   * up at all, which resurrects the stale-pidfile problem the daemon already
   * has machinery for.
   */
  it("direction A: the pidfile survives a stop that left the daemon alive", async () => {
    const d = await bootDaemonWithActiveJob("stop-inv-pidfile-live");

    await runCliAsync([ENTRY, "daemon", "stop"], d.cliEnv, 30_000);

    expect(d.getExitState().exited, "precondition: the daemon must still be draining").toBe(false);
    const after = readPidfile(d.pidfilePath);
    expect(
      after,
      "the pidfile was unlinked while its daemon was still alive — the next ensureRunning() will spawn a " +
      "duplicate against a daemon nobody can address",
    ).not.toBeNull();
    expect(after!.pid).toBe(d.pid);
    expect(isAlive(after!.pid)).toBe(true);
  }, 90_000);

  it("direction B: the pidfile is gone once the daemon is confirmed dead", async () => {
    const d = await bootDaemonWithActiveJob("stop-inv-pidfile-dead");

    await runCliAsync([ENTRY, "daemon", "stop", "--force"], d.cliEnv, 40_000);
    await waitUntil(() => d.getExitState().exited, 5_000, 50);

    await waitUntil(() => !existsSync(d.pidfilePath), 5_000, 100).catch(() => { /* assert below */ });
    expect(
      existsSync(d.pidfilePath),
      "the daemon exited but left its pidfile behind — every later caller reads a dead pid",
    ).toBe(false);
  }, 90_000);
});
