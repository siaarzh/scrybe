/**
 * Plan 108 Slice 4 — SIGTERM escalation.
 *
 * Defect 3 (the incident): daemonShutdownMaxWaitMs defaults to 30 minutes so
 * a genuine reindex can drain cleanly on SIGTERM/SIGINT. Under memory
 * pressure that same 30-minute grace made four orphaned daemons unkillable
 * in practice — SIGTERM produced zero RSS movement in 3s and they had to be
 * SIGKILLed. They were not wedged, just politely draining.
 *
 * Fix: a SECOND SIGTERM/SIGINT arriving while a shutdown is already in
 * progress bypasses the drain and exits immediately. The FIRST signal's
 * 30-minute default is left untouched — shortening it would silently abort
 * genuine long reindexes (explicitly rejected in the grill).
 *
 * Also fixes a real collision this test uncovered: src/index.ts's generic
 * CLI entry registers its own blanket SIGTERM/SIGINT listener (a Ctrl+C
 * convenience for one-shot commands like `scrybe index -f`) BEFORE
 * dispatching to `daemon start`/`daemon restart`. Node invokes same-event
 * listeners in registration order, and that earlier listener calls
 * process.exit(0) synchronously — which ends the process before runDaemon()'s
 * own, later-registered listener ever runs. Left alone, every signal is
 * swallowed by the generic handler and the drain/escalation logic below is
 * unreachable. main.ts now clears any pre-existing SIGTERM/SIGINT listeners
 * before installing its own, right before this exact behaviour is exercised.
 *
 * This test spawns a real daemon against a scratch data dir, registers a
 * project + code source (source add auto-enqueues a real reindex job —
 * genuine work in flight, not a mock), confirms via GET /status that the
 * job is active, then:
 *   1. Sends ONE SIGTERM and confirms the daemon is still alive shortly
 *      after — proving the first signal still drains rather than force-
 *      exiting (first-signal behaviour unchanged).
 *   2. Sends a SECOND SIGTERM and confirms the daemon exits fast — proving
 *      the escalation path fires.
 *   3. Confirms the escalation event landed in daemon-log.jsonl (written via
 *      diagEmit's synchronous appendFileSync, so it is guaranteed durable
 *      before process.exit() — unlike the buffered daemon.log stream) so the
 *      fast exit is attributable to the escalation code path specifically,
 *      not to the job simply finishing to complete on its own.
 *
 * SCRYBE_TEST_WRITE_DELAY_MS (existing test-only knob already used by
 * tests/scenarios/two-writer-race.test.ts, unmodified here) widens the job's
 * active window — measured empirically to keep this 40-file corpus's single
 * write batch active for ~(delay + ~1s) wall time — so this test isn't
 * racing a fast in-memory embed+write against the two signals.
 * SCRYBE_MODEL_CACHE_DIR points at the real, already-populated
 * local-embedder cache (read-only) so the daemon doesn't need to download
 * Xenova/multilingual-e5-small.
 */
import { describe, it, expect, afterEach } from "vitest";
import { spawn, spawnSync } from "child_process";
import { existsSync, readFileSync, mkdtempSync, rmSync } from "fs";
import { join } from "path";
import { tmpdir, platform } from "os";
import { makeTempRepo, type TempRepo } from "./scenarios/helpers/repo.js";
import { isLockHeld } from "./helpers/lock-probe.js";

const NODE = process.execPath;
const ENTRY = join(process.cwd(), "dist/index.js");
/**
 * Review F13: do NOT hardcode `~/.local/share/scrybe/models`. That path is
 * Linux-only (see config.ts's per-platform data dir), it reaches into the
 * developer's REAL data dir from a test — against this suite's own rule — and
 * passing it as SCRYBE_MODEL_CACHE_DIR overrides the job-level
 * `${{ github.workspace }}/.model-cache` that test.yml caches, forcing CI to
 * re-download the HF weights. Inherit whatever the environment already set
 * (tests/isolate.ts routes embedding through the sidecar anyway); when unset,
 * pass nothing and let config.ts pick the platform default.
 */
const INHERITED_MODEL_CACHE_DIR = process.env["SCRYBE_MODEL_CACHE_DIR"];

/**
 * Review F4: `child.kill("SIGTERM")` is not catchable on Windows — Node maps
 * it to TerminateProcess, so the child dies on the FIRST signal and the
 * "still alive after one signal" assertion can never hold. Same gate as
 * tests/daemon-fs-watch.test.ts and tests/plan92-slice4-sidecar-teardown.ts.
 */
const describeSignals = platform() === "win32" ? describe.skip : describe;

function makeDataDir() {
  return mkdtempSync(join(tmpdir(), "scrybe-sigterm-esc-test-"));
}

async function waitUntil(
  check: () => Promise<boolean> | boolean,
  timeoutMs = 15000,
  intervalMs = 100
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await check()) return;
    await new Promise((r) => setTimeout(r, intervalMs));
  }
  throw new Error("waitUntil timed out");
}

/** Runs a CLI command as a real child WITHOUT blocking this process's event loop. */
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

interface PidfileData { pid: number; port: number }
function readPidfile(pidfilePath: string): PidfileData | null {
  if (!existsSync(pidfilePath)) return null;
  try {
    return JSON.parse(readFileSync(pidfilePath, "utf8"));
  } catch {
    return null;
  }
}

const activeDataDirs: string[] = [];
const activeChildren: ReturnType<typeof spawn>[] = [];
let repo: TempRepo | null = null;

afterEach(() => {
  for (const c of activeChildren) {
    if (!c.killed) { try { c.kill("SIGKILL"); } catch { /* ignore */ } }
  }
  activeChildren.length = 0;
  for (const dir of activeDataDirs) {
    try { rmSync(dir, { recursive: true, force: true }); } catch { /* ignore */ }
  }
  activeDataDirs.length = 0;
  repo?.cleanup();
  repo = null;
});

/**
 * Spawns a real daemon against a scratch data dir, registers a project +
 * code source (auto-enqueuing a real reindex job), and waits until that job
 * is confirmed active via GET /status. Returns everything the caller needs
 * to signal the daemon and assert on its exit.
 */
async function bootDaemonWithActiveJob(opts: { projectId: string; writeDelayMs: number }): Promise<{
  child: ReturnType<typeof spawn>;
  dataDir: string;
  baseUrl: string;
  cliEnv: NodeJS.ProcessEnv;
  daemonLogJsonlPath: string;
  getExitState: () => { exited: boolean; code: number | null; signal: NodeJS.Signals | null };
}> {
  const files: Record<string, string> = {};
  for (let i = 0; i < 40; i++) {
    files[`src/file${i}.ts`] = `export function fn${i}(x: number): number {\n  return x + ${i};\n}\n`.repeat(20);
  }
  repo = makeTempRepo(files);

  const dataDir = makeDataDir();
  activeDataDirs.push(dataDir);
  const pidfilePath = join(dataDir, "daemon.pid");
  const daemonLogJsonlPath = join(dataDir, "daemon-log.jsonl");

  const daemonEnv = {
    ...process.env,
    SCRYBE_DATA_DIR: dataDir,
    SCRYBE_SKIP_MIGRATION: "1",
    SCRYBE_DAEMON_PORT: "0",
    ...(INHERITED_MODEL_CACHE_DIR ? { SCRYBE_MODEL_CACHE_DIR: INHERITED_MODEL_CACHE_DIR } : {}),
    SCRYBE_TEST_WRITE_DELAY_MS: String(opts.writeDelayMs),
  };

  const child = spawn(NODE, [ENTRY, "daemon", "start"], { env: daemonEnv, stdio: "ignore", detached: false, windowsHide: true });
  activeChildren.push(child);

  let exited = false;
  let exitCode: number | null = null;
  let exitSignal: NodeJS.Signals | null = null;
  child.once("exit", (code, signal) => {
    exited = true;
    exitCode = code;
    exitSignal = signal;
  });

  await waitUntil(() => {
    const d = readPidfile(pidfilePath);
    return !!d && d.port > 0;
  }, 20000);

  const { port } = readPidfile(pidfilePath)!;
  const baseUrl = `http://127.0.0.1:${port}`;
  await waitUntil(async () => {
    try { return (await fetch(`${baseUrl}/health`)).ok; } catch { return false; }
  }, 10000);

  // Register project + code source. `source add` auto-enqueues a real
  // reindex job against the daemon we just started — genuine work in
  // flight, not a mock.
  const cliEnv = { ...process.env, SCRYBE_DATA_DIR: dataDir, SCRYBE_SKIP_MIGRATION: "1" };
  const addProject = spawnSync(NODE, [ENTRY, "project", "add", "--id", opts.projectId], {
    env: cliEnv, encoding: "utf8", timeout: 15000, windowsHide: true,
  });
  expect(addProject.status, addProject.stderr).toBe(0);

  const addSource = spawnSync(NODE, [
    ENTRY, "source", "add", "-P", opts.projectId, "-S", "primary",
    "--type", "code", "--root", repo.path, "--languages", "ts",
  ], { env: cliEnv, encoding: "utf8", timeout: 20000, windowsHide: true });
  expect(addSource.status, addSource.stderr).toBe(0);

  // Confirm the job is genuinely active before touching signals.
  await waitUntil(async () => {
    try {
      const data = await (await fetch(`${baseUrl}/status`)).json() as { queue?: { active?: number } };
      return (data.queue?.active ?? 0) >= 1;
    } catch { return false; }
  }, 10000);

  return {
    child,
    dataDir,
    baseUrl,
    cliEnv,
    daemonLogJsonlPath,
    getExitState: () => ({ exited, code: exitCode, signal: exitSignal }),
  };
}

describeSignals("SIGTERM/SIGINT escalation (Plan 108 slice 4)", () => {
  it(
    "single SIGTERM still drains; a second SIGTERM while draining exits fast",
    async () => {
      const { child, dataDir, baseUrl, daemonLogJsonlPath, getExitState } = await bootDaemonWithActiveJob({
        projectId: "sigterm-esc",
        writeDelayMs: 8000,
      });

      // ── First SIGTERM: starts the drain (30-min default cap, unchanged).
      child.kill("SIGTERM");

      // Give the drain loop time to actually be polling (not force-exited).
      // With a real job still active and an 8s write-delay in effect, the
      // daemon must still be alive here if the first-signal behaviour is
      // unchanged.
      await new Promise((r) => setTimeout(r, 800));
      expect(getExitState().exited, "daemon exited on the FIRST SIGTERM alone — first-signal drain behaviour regressed").toBe(false);

      // ── The HTTP server must stay LISTENING for the whole drain.
      // It used to be closed as shutdown()'s first act, so for up to 30
      // minutes the pidfile existed and data-dir ownership was held while
      // nothing answered — every ensureRunning() in that window won the spawn
      // lock, spawned a daemon that died on contended ownership, and timed
      // out. /health must answer 200 specifically (pidfile.ts maps any non-2xx
      // to "refused" and then SIGKILLs the pid), with `draining: true` as the
      // diagnostic.
      const drainingHealth = await fetch(`${baseUrl}/health`);
      expect(drainingHealth.status).toBe(200);
      const drainingBody = await drainingHealth.json() as { ready?: boolean; draining?: boolean };
      expect(drainingBody.ready).toBe(true);
      expect(drainingBody.draining).toBe(true);

      // The drain gate is two-phase and deliberately NARROW: `draining` refuses
      // only routes that enqueue NEW work, because stopQueue()/closeDB() run
      // after the drain — the DB is open throughout, so reads have no reason to
      // fail. An earlier revision 503'd every route below /health, which put
      // /mcp/rpc (every MCP tool call) behind the gate for up to 30 minutes and,
      // because the shim only retries connect-class errors, made that outage
      // unrecoverable. Reads must keep serving; only mutations refuse.
      const drainingStatus = await fetch(`${baseUrl}/status`);
      expect(drainingStatus.status, "reads must keep serving during the drain").toBe(200);

      const drainingKick = await fetch(`${baseUrl}/kick`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: "{}",
      });
      expect(drainingKick.status).toBe(503);

      // ── Second SIGTERM: must escalate to a fast exit instead of
      // continuing to wait out the (unchanged) 30-minute cap.
      const t0 = Date.now();
      child.kill("SIGTERM");

      await waitUntil(() => getExitState().exited, 5000, 50);
      const elapsedMs = Date.now() - t0;
      const final = getExitState();

      expect(final.exited).toBe(true);
      expect(elapsedMs).toBeLessThan(5000);
      // Review F3: escalation exits 0, not 1. systemd installs the unit with
      // Restart=on-failure, so a non-zero exit would make a double `kill -TERM`
      // resurrect the daemon 5s later — the exact inverse of the intent.
      expect(final.code).toBe(0);
      expect(final.signal).toBeNull();

      // Prove the escalation path specifically fired (not just "the job
      // happened to finish on its own at the same moment").
      await waitUntil(() => existsSync(daemonLogJsonlPath), 3000);
      const events = readFileSync(daemonLogJsonlPath, "utf8")
        .split("\n")
        .filter(Boolean)
        .map((line) => { try { return JSON.parse(line); } catch { return null; } })
        .filter(Boolean) as Array<{ event?: string; signal?: string }>;
      expect(events.some((e) => e.event === "daemon.shutdown.escalated" && e.signal === "SIGTERM")).toBe(true);

      // Review F3: an escalated exit jumps the queue past shutdown()'s
      // removePidfile()/releaseDataDirOwnership(), so it must clean up after
      // itself. A stranded owner lock is exactly the permanent silent outage
      // (every future runDaemon() exits 0 quietly) this plan exists to remove.
      expect(existsSync(join(dataDir, "daemon.pid"))).toBe(false);
      expect(isLockHeld(dataDir, "owner"), "data-dir ownership was not released on exit").toBe(false);
    },
    90_000
  );

  it(
    "a second SIGINT while draining also escalates to a fast exit",
    async () => {
      const { child, daemonLogJsonlPath, getExitState } = await bootDaemonWithActiveJob({
        projectId: "sigint-esc",
        writeDelayMs: 8000,
      });

      child.kill("SIGINT");
      await new Promise((r) => setTimeout(r, 800));
      expect(getExitState().exited, "daemon exited on the FIRST SIGINT alone").toBe(false);

      const t0 = Date.now();
      child.kill("SIGINT");
      await waitUntil(() => getExitState().exited, 5000, 50);
      const elapsedMs = Date.now() - t0;
      const final = getExitState();

      expect(final.exited).toBe(true);
      expect(elapsedMs).toBeLessThan(5000);
      expect(final.code).toBe(0);

      await waitUntil(() => existsSync(daemonLogJsonlPath), 3000);
      const events = readFileSync(daemonLogJsonlPath, "utf8")
        .split("\n")
        .filter(Boolean)
        .map((line) => { try { return JSON.parse(line); } catch { return null; } })
        .filter(Boolean) as Array<{ event?: string; signal?: string }>;
      expect(events.some((e) => e.event === "daemon.shutdown.escalated" && e.signal === "SIGINT")).toBe(true);
    },
    90_000
  );

  it(
    "`scrybe daemon stop` preserves the drain and reports honestly; --force escalates",
    async () => {
      // Two contracts in one test, because they are only meaningful together.
      //
      // Default `daemon stop` must NOT escalate. An earlier revision had the
      // CLI fire a second SIGTERM unconditionally after 5 s, which tripped the
      // daemon's escalation branch and process.exit(0)'d it — skipping
      // stopQueue()/cancelAllJobs()/closeDB() and aborting an in-flight reindex
      // mid-write-batch. That made the documented 30-minute drain
      // (SCRYBE_DAEMON_SHUTDOWN_MAX_WAIT_MS, docs/configuration.md) unreachable
      // from every product surface. Waiting is the documented default; not
      // waiting is what `--force` is for.
      //
      // What the CLI must still get right in BOTH cases: never force-unlink a
      // pidfile under a live pid (that strands data-dir ownership and leaves a
      // daemon nothing can rediscover), and never claim "stopped" until the
      // process is provably gone.
      const { child, dataDir, cliEnv, daemonLogJsonlPath, getExitState } = await bootDaemonWithActiveJob({
        projectId: "cli-stop-esc",
        writeDelayMs: 12_000,
      });

      // Deliberately async, NOT spawnSync: the daemon under test is a child of
      // THIS vitest process, and spawnSync would block its event loop for the
      // whole stop — so the daemon would linger as an unreaped zombie and the
      // CLI would (correctly, per bare pid-liveness) keep reporting it alive.
      // A test artifact, not product behaviour; the daemon is detached from the
      // stopping CLI in production.
      const stop = await runCliAsync([ENTRY, "daemon", "stop"], cliEnv, 60_000);

      // Honest report: it says the daemon is STILL DRAINING, and does not lie
      // about having stopped it — including in its EXIT STATUS, which is all a
      // shell caller sees. Exit 3 is "accepted, still draining" (distinct from
      // 1, "could not signal it"); exit 0 is reserved for "the daemon is gone".
      // See tests/plan108-stop-invariants.test.ts for why this is load-bearing.
      expect(stop.status, `${stop.stdout}\n${stop.stderr}`).toBe(3);
      expect(stop.stdout).toContain("still draining");
      expect(stop.stdout).not.toContain("Daemon stopped.");

      // The drain was preserved — the daemon is still alive finishing its work,
      // and its pidfile/ownership are intact so it remains discoverable.
      expect(getExitState().exited, "default stop must not escalate — the drain is the documented contract").toBe(false);
      expect(existsSync(join(dataDir, "daemon.pid"))).toBe(true);
      expect(isLockHeld(dataDir, "owner"), "ownership must be held for the whole drain").toBe(true);

      let events = readFileSync(daemonLogJsonlPath, "utf8")
        .split("\n").filter(Boolean)
        .map((line) => { try { return JSON.parse(line); } catch { return null; } })
        .filter(Boolean) as Array<{ event?: string }>;
      expect(events.some((e) => e.event === "daemon.shutdown.escalated")).toBe(false);

      // ── Now the opt-in: `--force` is what asks to skip the drain.
      const force = await runCliAsync([ENTRY, "daemon", "stop", "--force"], cliEnv, 60_000);

      expect(force.status, `${force.stdout}\n${force.stderr}`).toBe(0);
      expect(force.stdout).toContain("Daemon stopped.");

      // "Stopped" must be the truth, not a hopeful message.
      await waitUntil(() => getExitState().exited, 5000, 50);
      expect(getExitState().exited).toBe(true);
      expect(existsSync(join(dataDir, "daemon.pid"))).toBe(false);
      expect(isLockHeld(dataDir, "owner"), "data-dir ownership was not released on exit").toBe(false);

      // And it got there via the escalation path — the drain would otherwise
      // have run the 30-minute default with a 12 s write delay in flight.
      events = readFileSync(daemonLogJsonlPath, "utf8")
        .split("\n").filter(Boolean)
        .map((line) => { try { return JSON.parse(line); } catch { return null; } })
        .filter(Boolean) as Array<{ event?: string }>;
      expect(events.some((e) => e.event === "daemon.shutdown.escalated")).toBe(true);

      if (!child.killed) { try { child.kill("SIGKILL"); } catch { /* ignore */ } }
    },
    180_000
  );
});
