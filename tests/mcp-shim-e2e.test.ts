/**
 * Plan 121 Slice 1 — end-to-end harness for `runMcpShim()`.
 *
 * `runMcpShim()` (src/mcp-shim.ts) is imported only by `src/index.ts` and by
 * nothing under tests/. The existing shim tests (mcp-shim.test.ts,
 * mcp-shim-port-reresolve.test.ts) drive the `__testing` seam — they never
 * spawn the real entrypoint or exercise a real MCP handshake.
 *
 * This file closes that gap by spawning the BUILT entrypoint (`dist/index.js
 * mcp`) as a real child process, connecting to it over a real stdio
 * transport with the real MCP SDK `Client`, and driving
 * initialize -> tools/list -> tools/call. It asserts on observed protocol
 * traffic, never on internals. Pattern adapted from a fidelity probe built
 * on the same SDK objects the shim itself uses, extended here with a real
 * client-side transport.
 *
 * SAFETY — every scenario here:
 *   - Uses its own scratch SCRYBE_DATA_DIR under the OS temp dir (own
 *     mkdtemp, independent of tests/isolate.ts's per-test dir) — never the
 *     user's real ~/.local/share/scrybe.
 *   - Sets SCRYBE_NO_AUTO_DAEMON=1 on every spawned child. `ensureRunning()`
 *     checks that env var FIRST, unconditionally, before touching the
 *     pidfile or attempting a spawn — so no scenario here ever spawns (or
 *     fights the user's live daemon's lock for) a real scrybe daemon.
 *     "Daemon becoming ready" is simulated with a fake in-process HTTP
 *     server (`startFakeDaemon`, tests/helpers/daemon.ts) plus a hand-written
 *     pidfile pointing at it, never a real daemon process.
 *
 * Requires `npm run build` first (spawns dist/index.js, not src/) — enforced
 * by the dist-freshness check below rather than by convention.
 */
import { describe, it, expect, beforeAll, beforeEach, afterEach } from "vitest";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, readdirSync, statSync } from "fs";
import { join, dirname } from "path";
import { tmpdir } from "os";
import { fileURLToPath } from "url";
import { spawn, type ChildProcess } from "node:child_process";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { getDefaultEnvironment } from "@modelcontextprotocol/sdk/client/stdio.js";
import { ReadBuffer, serializeMessage } from "@modelcontextprotocol/sdk/shared/stdio.js";
import type { Transport } from "@modelcontextprotocol/sdk/shared/transport.js";
import type { JSONRPCMessage } from "@modelcontextprotocol/sdk/types.js";
import { startFakeDaemon, PACKAGE_VERSION, type FakeDaemon } from "./helpers/daemon.js";

/**
 * Finding 4 — the SDK's own `StdioClientTransport` (`client/stdio.js`) spawns
 * the child via `cross-spawn` with
 * `windowsHide: process.platform === 'win32' && isElectron()`, which is
 * always false under vitest (not Electron), and its constructor only accepts
 * `StdioServerParameters` — there is no field to inject `windowsHide`
 * through. This project's absolute rule ("every `child_process` call must
 * pass `windowsHide: true`") means that transport cannot be used unmodified
 * here.
 *
 * This spawns the child itself with `windowsHide: true` forced
 * unconditionally, and otherwise mirrors `StdioClientTransport` exactly:
 * same newline-delimited JSON framing, via the SDK's OWN `ReadBuffer` /
 * `serializeMessage` (`shared/stdio.js`, both exported from the package) and
 * the SDK's own `getDefaultEnvironment()` (`client/stdio.js`, also
 * exported) — nothing about the wire protocol or the inherited-env
 * allowlist is hand-rolled, only the spawn call itself.
 */
class WindowsHiddenStdioTransport implements Transport {
  private _process?: ChildProcess;
  private _readBuffer = new ReadBuffer();
  private _params: { command: string; args?: string[]; env?: Record<string, string> };

  onclose?: () => void;
  onerror?: (error: Error) => void;
  onmessage?: (message: JSONRPCMessage) => void;

  constructor(params: { command: string; args?: string[]; env?: Record<string, string> }) {
    this._params = params;
  }

  start(): Promise<void> {
    if (this._process) {
      throw new Error("WindowsHiddenStdioTransport already started!");
    }
    return new Promise((resolve, reject) => {
      const child = spawn(this._params.command, this._params.args ?? [], {
        env: { ...getDefaultEnvironment(), ...this._params.env },
        stdio: ["pipe", "pipe", "inherit"],
        shell: false,
        windowsHide: true,
      });
      this._process = child;

      child.on("error", (error) => {
        reject(error);
        this.onerror?.(error);
      });
      child.on("spawn", () => resolve());
      child.on("close", () => {
        this._process = undefined;
        this.onclose?.();
      });
      child.stdin?.on("error", (error) => this.onerror?.(error));
      child.stdout?.on("data", (chunk: Buffer) => {
        this._readBuffer.append(chunk);
        this._processReadBuffer();
      });
      child.stdout?.on("error", (error) => this.onerror?.(error));
    });
  }

  private _processReadBuffer(): void {
    while (true) {
      let message: JSONRPCMessage | null;
      try {
        message = this._readBuffer.readMessage();
      } catch (error) {
        this.onerror?.(error as Error);
        return;
      }
      if (message === null) break;
      this.onmessage?.(message);
    }
  }

  async close(): Promise<void> {
    if (this._process) {
      const proc = this._process;
      this._process = undefined;
      const closed = new Promise<void>((resolve) => proc.once("close", () => resolve()));
      try {
        proc.stdin?.end();
      } catch {
        // ignore
      }
      await Promise.race([closed, new Promise((r) => setTimeout(r, 2000).unref())]);
      if (proc.exitCode === null) {
        try {
          proc.kill("SIGTERM");
        } catch {
          // ignore
        }
        await Promise.race([closed, new Promise((r) => setTimeout(r, 2000).unref())]);
      }
      if (proc.exitCode === null) {
        try {
          proc.kill("SIGKILL");
        } catch {
          // ignore
        }
      }
    }
    this._readBuffer.clear();
  }

  send(message: JSONRPCMessage): Promise<void> {
    return new Promise((resolve) => {
      if (!this._process?.stdin) throw new Error("Not connected");
      const json = serializeMessage(message);
      if (this._process.stdin.write(json)) resolve();
      else this._process.stdin.once("drain", resolve);
    });
  }
}

const __dirname = dirname(fileURLToPath(import.meta.url));
const DIST_INDEX = join(__dirname, "..", "dist", "index.js");
const SRC_DIR = join(__dirname, "..", "src");
const SCRYBE_VERSION = PACKAGE_VERSION;

// ─── dist freshness (Finding 4) ───────────────────────────────────────────────
//
// Every scenario here spawns `dist/index.js`, so a stale build silently
// exercises the PREVIOUS code and reports green. `pretest` covers `npm test`
// and nothing else: not `npm run test:watch`, and not a bare `npx vitest run
// <file>`, which is the command this repo's conventions prescribe for a
// targeted run — i.e. exactly how this file is usually invoked. The check
// therefore lives in the file itself, where no invocation can skip it.

function newestMtimeMs(dir: string): number {
  let newest = 0;
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name);
    const mtime = entry.isDirectory() ? newestMtimeMs(full) : statSync(full).mtimeMs;
    if (mtime > newest) newest = mtime;
  }
  return newest;
}

beforeAll(() => {
  let distMtime: number;
  try {
    distMtime = statSync(DIST_INDEX).mtimeMs;
  } catch {
    throw new Error(
      `${DIST_INDEX} does not exist — this suite spawns the BUILT entrypoint. Run \`npm run build\` first.`
    );
  }
  const srcMtime = newestMtimeMs(SRC_DIR);
  if (srcMtime > distMtime) {
    throw new Error(
      `dist/ is stale: src/ was modified after dist/index.js was built ` +
        `(src ${new Date(srcMtime).toISOString()} > dist ${new Date(distMtime).toISOString()}). ` +
        `This suite spawns dist/index.js, so it would test the previous code and pass. Run \`npm run build\`.`
    );
  }
});

// ─── Pidfile helper ────────────────────────────────────────────────────────────

function writePidfile(dataDir: string, port: number): void {
  mkdirSync(dataDir, { recursive: true });
  writeFileSync(
    join(dataDir, "daemon.pid"),
    JSON.stringify({
      // The shim's own daemon detection never reads this (it goes by port +
      // /health). The in-process `doctor` tool DOES: `isDaemonRunning()`
      // removes a pidfile whose recorded pid is not alive, so a scenario that
      // calls `doctor` in-process has to expect this file to be gone
      // afterwards (see Scenario 10). A live pid is not a safe substitute —
      // that same function SIGKILLs a live pid whose port refuses, which for
      // `process.pid` would kill the test runner.
      pid: 999999,
      port,
      startedAt: new Date().toISOString(),
      version: SCRYBE_VERSION,
      dataDir,
      execPath: process.execPath,
    }),
    "utf8"
  );
}

// ─── Client-side harness: spawn the REAL entrypoint over a real stdio transport ─

interface Harness {
  client: Client;
  close: () => Promise<void>;
}

/**
 * Finding 12 — `harnesses.push(harness)` used to happen at every CALL SITE,
 * always AFTER `await connectShim(...)` had already resolved — i.e. always
 * after `client.connect()` had already spawned the child. A `connect()`
 * rejection (the child dies before completing the handshake, a transport
 * error, etc.) meant `connectShim` itself never returned, so nothing was
 * ever pushed and `afterEach` never closed that child — a leaked node
 * process on every such failure. Registering the harness here, before
 * `connect()` is awaited, means `afterEach` reaps it regardless of whether
 * `connect()` ever resolves. Callers no longer push it themselves.
 */
async function connectShim(
  dataDir: string,
  extraEnv: Record<string, string> = {},
  clientOptions: ConstructorParameters<typeof Client>[1] = { capabilities: {} }
): Promise<Harness> {
  const transport = new WindowsHiddenStdioTransport({
    command: process.execPath,
    args: [DIST_INDEX, "mcp"],
    env: {
      SCRYBE_DATA_DIR: dataDir,
      SCRYBE_NO_AUTO_DAEMON: "1",
      // Finding 5 — drive the readiness poller from an explicit short
      // interval in EVERY scenario, not just the ones that remembered to ask.
      // A scenario left on the 2000ms default is one whose outcome depends on
      // whether a single tick lands inside its budget, which is how a suite
      // that passes alone starts failing co-scheduled under load. Scenarios
      // that need a different value still override it via `extraEnv`.
      SCRYBE_MCP_LISTCHANGED_POLL_INTERVAL_MS: "100",
      ...extraEnv,
    },
  });

  const client = new Client({ name: "plan-121-e2e-harness", version: "1.0.0" }, clientOptions);
  const harness: Harness = {
    client,
    close: async () => { await client.close(); },
  };
  harnesses.push(harness);

  await client.connect(transport);

  return harness;
}

// ─── Test scaffolding ───────────────────────────────────────────────────────────

let scratchRoot = "";
const daemons: FakeDaemon[] = [];
const harnesses: Harness[] = [];

beforeEach(() => {
  scratchRoot = mkdtempSync(join(tmpdir(), "scrybe-mcp-shim-e2e-"));
});

afterEach(async () => {
  for (const h of harnesses.splice(0)) {
    await h.close().catch(() => { /* best-effort */ });
  }
  for (const d of daemons.splice(0)) {
    await d.close().catch(() => { /* best-effort */ });
  }
  if (scratchRoot) {
    // Finding 12 — mirrors tests/isolate.ts's EBUSY/EPERM retry: a child
    // process that only just exited (see the harness cleanup above) can
    // still hold a file handle open under it for a brief window, most
    // commonly on Windows.
    try {
      rmSync(scratchRoot, { recursive: true, force: true });
    } catch {
      await new Promise((r) => setTimeout(r, 500));
      try {
        rmSync(scratchRoot, { recursive: true, force: true });
      } catch {
        // ignore — OS will clean up on reboot
      }
    }
    scratchRoot = "";
  }
});

function scratchDataDir(name: string): string {
  return join(scratchRoot, name);
}

/**
 * Polls `predicate` until it's true or `timeoutMs` elapses (throws on timeout).
 *
 * Finding 5 — budgets here are deliberately GENEROUS (`WAIT_BUDGET_MS`), never
 * tuned to "about how long it takes". A `waitUntil` returns the moment its
 * condition holds, so a large budget costs a passing run nothing; it only buys
 * headroom for a machine running several suites at once. The 5s budgets these
 * replaced were the suite's main source of co-scheduled flake.
 */
async function waitUntil(predicate: () => boolean, timeoutMs: number, intervalMs = 20): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (predicate()) return;
    await new Promise((r) => setTimeout(r, intervalMs));
  }
  if (!predicate()) throw new Error(`waitUntil: condition not met within ${timeoutMs}ms`);
}

/** One generous budget for every "eventually" in this file. See waitUntil. */
const WAIT_BUDGET_MS = 20_000;

/** Sleeps `ms`, for the few places that must let real time pass. */
function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

// ─── Scenario 1 — warm daemon at connect ────────────────────────────────────────

describe("runMcpShim e2e — warm daemon at connect", () => {
  it("initialize -> tools/list returns the real manifest immediately, tools/call round-trips through the daemon", async () => {
    const daemon = await startFakeDaemon({
      initialHealthy: true,
      tools: [
        { name: "list_projects", description: "List projects", inputSchema: { type: "object", properties: {}, required: [] } },
        { name: "queue_status", description: "Queue status", inputSchema: { type: "object", properties: {}, required: [] } },
      ],
    });
    daemons.push(daemon);

    const dataDir = scratchDataDir("warm");
    writePidfile(dataDir, daemon.port);

    const harness = await connectShim(dataDir);

    const { tools } = await harness.client.listTools();
    const names = tools.map((t) => t.name);
    expect(names).toContain("list_projects");
    expect(names).toContain("queue_status");
    // The degraded 3-tool placeholder set must NOT be what a warm connect serves.
    expect(names).not.toContain("doctor");

    const result = await harness.client.callTool({ name: "list_projects", arguments: {} });
    expect(result.isError).not.toBe(true);
    const text = (result.content[0] as { type: "text"; text: string }).text;
    const parsed = JSON.parse(text) as { method: string };
    expect(parsed.method).toBe("list_projects");
  });
});

// ─── Scenario 2 — daemon never becomes ready ────────────────────────────────────

describe("runMcpShim e2e — daemon never ready", () => {
  it("initialize -> tools/list serves the degraded 3-tool placeholder, tools/call resolves in-process", async () => {
    const dataDir = scratchDataDir("never-ready");
    // No pidfile at all — the "no-pidfile" unavailable variant.

    const harness = await connectShim(dataDir);

    const { tools } = await harness.client.listTools();
    const names = tools.map((t) => t.name).sort();
    expect(names).toEqual(["doctor", "init", "status"]);

    const result = await harness.client.callTool({ name: "status", arguments: {} });
    expect(result.isError).not.toBe(true);
    const text = (result.content[0] as { type: "text"; text: string }).text;
    const parsed = JSON.parse(text) as { daemon_running: boolean };
    expect(parsed.daemon_running).toBe(false);

    // Waiting does not change anything. The readiness poller IS running here,
    // but the daemon never becomes ready, so every probe finds it absent and
    // the served list stays degraded.
    await sleep(300);
    const relisted = await harness.client.listTools();
    expect(relisted.tools.map((t) => t.name).sort()).toEqual(["doctor", "init", "status"]);
  });
});

// ─── Scenario 3 — daemon cold at connect, then ready later ────────────────────
//
// THIS IS THE BUG THIS PLAN EXISTS TO FIX. `runMcpShim()` commits to
// `serveUnavailableServer()` once, at startup, and never looks again — there
// is no re-poll, no notification (capabilities.tools.listChanged is not even
// declared on that server), nothing. A daemon that becomes healthy a moment
// later is invisible to a session that already connected.
//
// Plan 121 Phase 3 flipped this from `it.fails` to `it`: daemon resolution
// now happens lazily inside the ListTools handler (getShimMode), re-probed
// on every call while the mode is "degraded", so a daemon that becomes
// healthy mid-session is picked up on the next tools/list — no push
// notification needed for that (Phase 5's job is making the CLIENT learn
// about it proactively via listChanged; here the client is polling anyway).

describe("runMcpShim e2e — daemon cold at connect, then ready later", () => {
  it(
    "tool surface upgrades once the daemon becomes healthy",
    async () => {
      const daemon = await startFakeDaemon({
        initialHealthy: false,
        tools: [
          { name: "list_projects", description: "List projects", inputSchema: { type: "object", properties: {}, required: [] } },
        ],
      });
      daemons.push(daemon);

      const dataDir = scratchDataDir("cold-then-ready");
      writePidfile(dataDir, daemon.port);

      const harness = await connectShim(dataDir);

      // Sanity: starts degraded, exactly as scenario 2 does.
      const initial = await harness.client.listTools();
      expect(initial.tools.map((t) => t.name).sort()).toEqual(["doctor", "init", "status"]);

      // The daemon becomes healthy mid-session (e.g. the operator ran
      // `scrybe daemon start` by hand). The shim process is already
      // committed to the degraded server and is never told.
      daemon.setHealthy(true);

      let sawRealTools = false;
      const deadline = Date.now() + WAIT_BUDGET_MS;
      while (Date.now() < deadline && !sawRealTools) {
        const { tools } = await harness.client.listTools();
        if (tools.some((t) => t.name === "list_projects")) sawRealTools = true;
        else await sleep(50);
      }

      // This is the assertion the whole change exists to satisfy: a session
      // that started cold ends up with the real tool surface, without a
      // reconnect. It failed before the resolution moved off the startup path.
      expect(sawRealTools).toBe(true);
    }
  );
});

// ─── Scenario 4 — D8 dispatch: name called after daemon came up ──────────────
//
// The client is still holding the degraded 3-tool list it fetched while the
// daemon was cold (it hasn't re-listed). The daemon comes up. The client
// calls `doctor` anyway. `doctor` exists as BOTH an in-process degraded
// implementation AND a real daemon tool name (src/tools/tool-names.ts) — D8
// requires CallTool to resolve against the mode current AT CALL TIME, not
// the mode that was live when the stale list was issued, so this must reach
// the daemon's implementation, not the in-process one.

describe("runMcpShim e2e — D8 dispatch: doctor called after daemon came up (stale degraded list)", () => {
  it("forwards to the daemon's doctor, not the in-process degradedDoctor", async () => {
    const daemon = await startFakeDaemon({
      initialHealthy: false,
      tools: [
        { name: "doctor", description: "Daemon doctor", inputSchema: { type: "object", properties: {}, required: [] } },
      ],
    });
    daemons.push(daemon);

    const dataDir = scratchDataDir("doctor-after-daemon-up");
    writePidfile(dataDir, daemon.port);

    const harness = await connectShim(dataDir);

    // Sanity: starts degraded, same as scenario 2/3.
    const initial = await harness.client.listTools();
    expect(initial.tools.map((t) => t.name).sort()).toEqual(["doctor", "init", "status"]);

    // Daemon comes up. The client does NOT re-list — it calls `doctor`
    // straight off the stale degraded list it already has.
    daemon.setHealthy(true);

    const result = await harness.client.callTool({ name: "doctor", arguments: {} });
    expect(result.isError).not.toBe(true);
    const text = (result.content[0] as { type: "text"; text: string }).text;
    const parsed = JSON.parse(text) as { ok?: boolean; method?: string; checks?: unknown };

    // The fake daemon's /mcp/rpc handler echoes { ok: true, method: <name> }
    // for every method. The in-process degradedDoctor() returns a report
    // shape with a `checks` array and no `method`/`ok` fields — so these two
    // implementations are structurally distinguishable.
    expect(parsed.method).toBe("doctor");
    expect(parsed.ok).toBe(true);
    expect(parsed.checks).toBeUndefined();
  });
});

// ─── Scenario 5 — D8 dispatch: name called after the daemon died ─────────────
//
// The session already resolved "healthy" (and getShimMode caches a terminal
// mode forever — see mcp-shim.ts). The daemon then dies mid-session. The
// client calls `status` — still believing, per its last successful list,
// that this is the daemon's `status`. D8 requires this to reach the
// in-process degraded implementation instead of a forward to a dead daemon
// (which would either hang, error, or — worse — silently keep "succeeding"
// against nothing). This is the exact hazard slice 3 left open: without an
// invalidation path, the cached "healthy" mode never notices the daemon is
// gone.

describe("runMcpShim e2e — D8 dispatch: status called after the daemon died (stale healthy mode)", () => {
  it("falls back to the in-process degradedStatus, not a forward to a dead daemon", async () => {
    const daemon = await startFakeDaemon({
      initialHealthy: true,
      tools: [
        { name: "list_projects", description: "List projects", inputSchema: { type: "object", properties: {}, required: [] } },
      ],
    });
    daemons.push(daemon);

    const dataDir = scratchDataDir("status-after-daemon-died");
    writePidfile(dataDir, daemon.port);

    const harness = await connectShim(dataDir);

    // Resolve + cache the "healthy" mode, same as scenario 1.
    const initial = await harness.client.listTools();
    const initialNames = initial.tools.map((t) => t.name).sort();
    expect(initialNames).toContain("list_projects");
    expect(initialNames).not.toContain("doctor");

    // The daemon dies for real — connections to its port now refuse, unlike
    // setHealthy(false) which only flips /health while the process (and
    // /mcp/rpc) stays reachable.
    await daemon.close();

    const result = await harness.client.callTool({ name: "status", arguments: {} });
    expect(result.isError).not.toBe(true);
    const text = (result.content[0] as { type: "text"; text: string }).text;
    const parsed = JSON.parse(text) as { daemon_running?: boolean; method?: string };

    // degradedStatus() always returns daemon_running:false and never a
    // `method` field; the (dead) daemon's echo shape would have `method`
    // set and no `daemon_running` key. This tells the two apart.
    expect(parsed.daemon_running).toBe(false);
    expect(parsed.method).toBeUndefined();

    // Regression check on the invalidation itself, not just this one call:
    // a subsequent tools/list must also reflect the mode flip, proving the
    // cache was actually invalidated rather than this call getting lucky
    // via some path that bypasses the cache entirely.
    const relisted = await harness.client.listTools();
    expect(relisted.tools.map((t) => t.name).sort()).toEqual(["doctor", "init", "status"]);
  });
});

// ─── Scenario 6 — D4/D9: the DECLARED CAPABILITY, not merely a sent notification ─
//
// This is the trap the plan calls out explicitly: measured against the real
// MCP SDK, server.sendToolListChanged() resolves without throwing whether or
// not `capabilities.tools.listChanged` was declared at construction — with
// it undeclared, the client's own SDK just never sets up a handler for the
// notification, silently, and no amount of "assert the notification was
// sent" can tell the two cases apart — this was measured against the real
// client before it was written down. So this test asserts the one thing that
// actually distinguishes working from broken: what the server reports at
// initialize, read back through the client's own getServerCapabilities().

describe("runMcpShim e2e — declares capabilities.tools.listChanged (Plan 121 D4)", () => {
  it("the client observes tools.listChanged: true at initialize", async () => {
    const daemon = await startFakeDaemon({
      initialHealthy: true,
      tools: [{ name: "list_projects", description: "List projects", inputSchema: { type: "object", properties: {}, required: [] } }],
    });
    daemons.push(daemon);

    const dataDir = scratchDataDir("capability-declared");
    writePidfile(dataDir, daemon.port);

    const harness = await connectShim(dataDir);

    const caps = harness.client.getServerCapabilities();
    expect(caps?.tools?.listChanged).toBe(true);
  });
});

// ─── Scenario 7 — the upgrade path is driven by the notification, not polling ──
//
// Scenario 3 (above) proves the tool surface upgrades if the client keeps
// calling tools/list on its own — that was slice 3's mechanism (re-probe per
// call) and needs no notification at all. This scenario is slice 5's actual
// job: a client that lists ONCE, then goes fully idle, must still end up
// with the real tool surface — which can only happen if the SERVER pushes
// notifications/tools/list_changed and the client's SDK (configured with a
// `listChanged` handler, which only activates when the capability was
// declared — see scenario 6) reacts to it on its own.

describe("runMcpShim e2e — upgrade path driven by the notification (Plan 121 D9)", () => {
  it("a client that lists once and then sits idle still gets the real tool surface", async () => {
    const daemon = await startFakeDaemon({
      initialHealthy: false,
      tools: [{ name: "list_projects", description: "List projects", inputSchema: { type: "object", properties: {}, required: [] } }],
    });
    daemons.push(daemon);

    const dataDir = scratchDataDir("notify-driven-upgrade");
    writePidfile(dataDir, daemon.port);

    const notifications: Array<{ toolNames: string[] | null }> = [];
    const harness = await connectShim(
      dataDir,
      { SCRYBE_MCP_LISTCHANGED_POLL_INTERVAL_MS: "100" },
      {
        capabilities: {},
        listChanged: {
          tools: {
            debounceMs: 0,
            onChanged: (_error, tools) => {
              notifications.push({ toolNames: tools ? tools.map((t) => t.name) : null });
            },
          },
        },
      }
    );

    // The ONLY tools/list call this test ever issues itself. Everything the
    // client learns after this point must come from the server pushing the
    // notification, not from the test (or the client) asking again.
    const initial = await harness.client.listTools();
    expect(initial.tools.map((t) => t.name).sort()).toEqual(["doctor", "init", "status"]);

    // Nobody calls tools/list again. The daemon just becomes ready in the
    // background — the readiness poller (armed by entering degraded above)
    // is what has to notice this and drive the notification.
    daemon.setHealthy(true);

    await waitUntil(
      () => notifications.some((n) => n.toolNames?.includes("list_projects")),
      WAIT_BUDGET_MS
    );
  });
});

// ─── Scenario 8 — no timer survives a never-ready daemon ─────────────────────
//
// The probe this design was modelled on (sdk-server.mjs) never clears its
// setInterval — acceptable in a probe that exits with the test, a leak in a
// long-lived MCP shim talking to a daemon that may simply never arrive
// (never configured, SCRYBE_NO_AUTO_DAEMON set, etc). This proves the
// background readiness poller actually stops once its ceiling elapses,
// by counting real GET /health hits on the fake daemon: growth stops once
// the ceiling has passed, rather than continuing forever at the poll
// interval.
//
// Fix round (MAJOR 3) — the original version of this test could not fail: a
// blind reviewer proved by mutation that stubbing
// startReadinessPollerIfNeeded() to an unconditional no-op (the poller never
// runs at all) still passed it, because `hitsAfterCeiling` was compared only
// against `1`, and resolveShimMode()'s OWN health probe(s) during the initial
// listTools() call — one from detectDaemonUnavailable(), a second re-probe
// after the (SCRYBE_NO_AUTO_DAEMON-opted-out, so instant) failed
// ensureRunning() attempt — already clear that bar on their own, with zero
// poller ticks. The fix captures a BASELINE right after that one-off cost,
// then requires real growth during a still-inside-the-ceiling window before
// asserting the later flatness — so a poller that never ran at all now fails
// the growth assertion instead of coincidentally satisfying it.

describe("runMcpShim e2e — no timer survives a never-ready daemon (Plan 121 D9)", () => {
  it("the background readiness poller actually polls, then stops once its ceiling elapses", async () => {
    // Finding 5 — a 250ms ceiling left this test needing a poller tick inside
    // a quarter-second window that a loaded machine can easily miss entirely.
    // A ceiling several ticks wide costs a passing run nothing (the growth
    // wait below returns on the first tick) and removes that race.
    const INTERVAL = 50;
    const CEILING = 2_000;

    const daemon = await startFakeDaemon({ initialHealthy: false, tools: [] });
    daemons.push(daemon);

    const dataDir = scratchDataDir("poller-ceiling");
    writePidfile(dataDir, daemon.port);

    const harness = await connectShim(dataDir, {
      SCRYBE_MCP_LISTCHANGED_POLL_INTERVAL_MS: String(INTERVAL),
      SCRYBE_MCP_LISTCHANGED_POLL_CEILING_MS: String(CEILING),
    });

    // Enter degraded once — this is what arms the poller in the first place.
    // It ALSO pays resolveShimMode()'s own one-off health-probe cost (see
    // above) — capture that as a baseline BEFORE asserting any growth, so
    // that fixed cost can never be mistaken for the poller having run.
    const initial = await harness.client.listTools();
    // The epoch (and so the ceiling) starts inside this call, so measuring
    // from here can only OVER-estimate how much of the window is left, never
    // under-estimate it.
    const armedAt = Date.now();
    expect(initial.tools.map((t) => t.name).sort()).toEqual(["doctor", "init", "status"]);
    const baselineHits = daemon.healthHitCount();

    // Finding 5 — wait for the poller to actually fire rather than sleeping a
    // guessed-at 150ms and hoping a tick landed in it. This is the assertion
    // a no-op poller stub fails (verified by mutation; see above), and the
    // budget is bounded by the CEILING because after that there is nothing
    // left to observe.
    await waitUntil(() => daemon.healthHitCount() > baselineHits, CEILING);
    const midHits = daemon.healthHitCount();

    // Well past the ceiling — the poller should have given up by now. Timed
    // from `armedAt` rather than by accumulating sleeps, so a slow machine
    // between the two waits cannot shift where this lands.
    await sleep(Math.max(0, armedAt + CEILING + 500 - Date.now()));
    const hitsAfterCeiling = daemon.healthHitCount();
    // It kept polling on the way to the ceiling, not just for one tick.
    expect(hitsAfterCeiling).toBeGreaterThan(midHits);

    // If a timer were still ticking every INTERVAL ms, another second would
    // add roughly 1000/INTERVAL more hits. A poller that stopped adds none.
    await sleep(1_000);
    expect(daemon.healthHitCount()).toBe(hitsAfterCeiling);
  });
});

// ─── Scenario 9 — a second readiness transition notifies again ───────────────
//
// D9's re-arm requirement: "ready -> dead -> ready" must fire
// sendToolListChanged() TWICE, not once with the latch staying permanently
// tripped. Exercises the full cycle: cold -> ready (first notify) -> the
// daemon dies for real -> a client call surfaces the D8 stale-mode
// invalidation (same shape as scenario 5) -> a follow-up handler call
// re-enters "degraded" for real -> a second daemon comes up on a new port
// (mirroring a real restart) -> second notify.

describe("runMcpShim e2e — a second readiness transition notifies again (Plan 121 D9 re-arm)", () => {
  it("ready -> dead -> ready fires the notification twice", async () => {
    const daemonA = await startFakeDaemon({
      initialHealthy: false,
      tools: [{ name: "list_projects", description: "List projects", inputSchema: { type: "object", properties: {}, required: [] } }],
    });
    daemons.push(daemonA);

    const dataDir = scratchDataDir("rearm-ready-dead-ready");
    writePidfile(dataDir, daemonA.port);

    const notifications: Array<{ toolNames: string[] | null }> = [];
    const harness = await connectShim(
      dataDir,
      { SCRYBE_MCP_LISTCHANGED_POLL_INTERVAL_MS: "100" },
      {
        capabilities: {},
        listChanged: {
          tools: {
            debounceMs: 0,
            onChanged: (_error, tools) => {
              notifications.push({ toolNames: tools ? tools.map((t) => t.name) : null });
            },
          },
        },
      }
    );

    // Enter degraded.
    const initial = await harness.client.listTools();
    expect(initial.tools.map((t) => t.name).sort()).toEqual(["doctor", "init", "status"]);

    // First transition: cold -> ready.
    daemonA.setHealthy(true);
    await waitUntil(
      () => notifications.some((n) => n.toolNames?.includes("list_projects")),
      WAIT_BUDGET_MS
    );
    const firstUpgradeCount = notifications.length;
    expect(firstUpgradeCount).toBeGreaterThanOrEqual(1);

    // The daemon dies for real (not setHealthy(false) — a live-but-unhealthy
    // daemon never invalidates the cached "healthy" mode; only a genuinely
    // unreachable one does, per D8).
    await daemonA.close();

    // The client still holds the "healthy" list it fetched a moment ago and
    // calls a tool off it — same shape as scenario 5. This is what
    // invalidates the cached mode.
    await harness.client
      .callTool({ name: "list_projects", arguments: {} })
      .catch(() => { /* expected to error — the daemon is gone */ });

    // A follow-up handler call is what actually re-resolves and re-enters
    // "degraded" (mirrors scenario 5's own relist-after-invalidation check).
    const afterDeath = await harness.client.listTools();
    expect(afterDeath.tools.map((t) => t.name).sort()).toEqual(["doctor", "init", "status"]);

    // Second daemon comes up on a new port (a real restart would rebind).
    const daemonB = await startFakeDaemon({
      initialHealthy: true,
      tools: [{ name: "list_projects", description: "List projects", inputSchema: { type: "object", properties: {}, required: [] } }],
    });
    daemons.push(daemonB);
    writePidfile(dataDir, daemonB.port);

    // Second transition: dead -> ready. Must notify AGAIN, not just once.
    await waitUntil(() => notifications.length > firstUpgradeCount, WAIT_BUDGET_MS);
    expect(notifications.length).toBeGreaterThan(firstUpgradeCount);
  });
});

// ─── Scenario 10 — MAJOR 1 fix round: version-mismatch serves the degraded 3-tool set ─
//
// At HEAD, serveUnavailableServer() built the 3-tool degraded set (status /
// doctor / init) for EVERY "unavailable" server it constructed, including
// the lancedb-boundary ("version-mismatch") one — the long explanatory text
// was only ever the CallTool fallback for a name outside that trio. The
// initial cut of this refactor collapsed "version-mismatch" into
// "major-skew"'s single scrybe_daemon_unavailable tool instead, silently
// dropping working in-process status/doctor/init for a session whose shim
// is >=0.34.0 and whose daemon is still <0.34.0 — precisely the
// diagnostics (and the recovery guidance) a user in that state needs. This
// is the test the blind reviewer found missing.

describe("runMcpShim e2e — version-mismatch mode serves the degraded 3-tool set, not a 1-tool placeholder (fix round MAJOR 1)", () => {
  it("tools/list returns status/doctor/init; status/doctor/init resolve in-process; an unknown name surfaces the upgrade guidance", async () => {
    const daemon = await startFakeDaemon({
      initialHealthy: true,
      daemonVersion: "0.33.5", // pre-0.34.0 lancedb boundary; SCRYBE_VERSION (this build) is post-boundary
      tools: [{ name: "list_projects", description: "List projects", inputSchema: { type: "object", properties: {}, required: [] } }],
    });
    daemons.push(daemon);

    const dataDir = scratchDataDir("version-mismatch");
    writePidfile(dataDir, daemon.port);

    const harness = await connectShim(dataDir);

    const { tools } = await harness.client.listTools();
    const names = tools.map((t) => t.name).sort();
    // The regression under test: this used to be ["scrybe_daemon_unavailable"].
    expect(names).toEqual(["doctor", "init", "status"]);
    // The daemon's real tools must not leak through this mode.
    expect(names).not.toContain("list_projects");
    expect(names).not.toContain("scrybe_daemon_unavailable");

    const statusResult = await harness.client.callTool({ name: "status", arguments: {} });
    expect(statusResult.isError).not.toBe(true);
    const statusText = (statusResult.content[0] as { type: "text"; text: string }).text;
    const statusParsed = JSON.parse(statusText) as { daemon_running?: boolean };
    // degradedStatus() is the in-process implementation, not a forward to
    // the (reachable but version-mismatched) daemon.
    expect(statusParsed.daemon_running).toBe(false);

    const doctorResult = await harness.client.callTool({ name: "doctor", arguments: {} });
    expect(doctorResult.isError).not.toBe(true);
    const doctorText = (doctorResult.content[0] as { type: "text"; text: string }).text;
    const doctorParsed = JSON.parse(doctorText) as { checks?: unknown };
    expect(doctorParsed.checks).toBeDefined();

    // That doctor run just DELETED the pidfile: it runs in-process, and
    // `isDaemonRunning()` clears a pidfile whose recorded pid is not alive —
    // which this fixture's pid deliberately is not (see writePidfile). A real
    // version-mismatched daemon has a live pid and keeps its pidfile, so this
    // is a fixture artifact, but the shim now re-resolves its mode on every
    // call (a skewed daemon that gets restarted has to be noticed), so
    // without restoring it the next call below would resolve "no pidfile ->
    // degraded" and assert against the wrong description.
    writePidfile(dataDir, daemon.port);

    // A name outside the degraded trio still falls back to the explanatory
    // upgrade-guidance description (parity with serveUnavailableServer's
    // "any unexpected tool name" fallback).
    const badNameResult = await harness.client.callTool({ name: "list_projects", arguments: {} });
    const badNameText = (badNameResult.content[0] as { type: "text"; text: string }).text;
    const badNameParsed = JSON.parse(badNameText) as { error?: string };
    expect(badNameParsed.error).toContain("scrybe daemon restart --force");
    expect(badNameParsed.error).toContain("lancedb");
  });
});

// ─── Scenario 11 — MAJOR (fix round 2): the readiness deadline does not
// outlive its degraded epoch ───────────────────────────────────────────────
//
// Second-round finding: `stopReadinessPoller()` cleared the poller HANDLE on
// leaving degraded but left `_readinessPollDeadline` untouched. Concretely,
// at defaults: cold start arms a deadline 300s out; the daemon comes up 3s
// later (poller stops, deadline still reads +300s); at ~299s the daemon dies
// mid-call; the D8 invalidation site sees that stale-but-not-yet-expired
// deadline, decides a poller is already "live" for it, and arms a fresh
// handle against the ~1s left on the OLD window — sometimes less than one
// poll interval, so the very first tick finds itself already past due and
// stops WITHOUT ever calling getShimMode() once. The daemon's return is then
// never noticed by a client that made one failing call and went idle.
//
// This reproduces that shape on a compressed timeline: enter degraded, go
// healthy quickly, then fail a call landing deliberately just before the
// OLD epoch's deadline would have elapsed — and confirm recovery still
// happens, purely via the background poller (no further handler calls at
// all), well past where the stale deadline would have killed it.

describe("runMcpShim e2e — the readiness deadline is scoped to its own epoch, not the process (fix round 2, MAJOR)", () => {
  it("a daemon that dies late in the OLD degraded window is still rediscovered by the background poller alone", async () => {
    // CEILING has generous headroom above the setup cost (process spawn +
    // first notification) so that the "fail late in the OLD window" wait
    // below reliably still has time left to wait, rather than racing past
    // it under slow CI and accidentally landing in the ALREADY-expired case
    // — which even the pre-fix code already handles correctly, and would
    // make this test pass for the wrong reason.
    //
    // Finding 5 — the two margins below are what keep this off a knife
    // edge. `LEFTOVER_MS` is how much of the OLD window is left when the
    // call fails: pre-fix, that sliver is the ENTIRE budget the re-armed
    // poller gets, so the test still catches the regression as long as the
    // sliver is shorter than `RECOVERY_GAP_MS` (how long the replacement
    // daemon takes to appear). It does not have to be razor-thin — it has
    // to be shorter than the gap, which is a 3x margin here rather than the
    // 40ms-vs-200ms one it replaces.
    const CEILING = 6_000;
    const INTERVAL = 50;
    const LEFTOVER_MS = 500;
    const RECOVERY_GAP_MS = 1_500;

    const daemonA = await startFakeDaemon({
      initialHealthy: false,
      tools: [{ name: "list_projects", description: "List projects", inputSchema: { type: "object", properties: {}, required: [] } }],
    });
    daemons.push(daemonA);

    const dataDir = scratchDataDir("stale-deadline-major");
    writePidfile(dataDir, daemonA.port);

    // The recovery this test looks for must arrive via the PUSH
    // notification, never via a handler call the test itself makes — a
    // handler call after the failure would trigger its own on-demand
    // resolution and could paper over a background poller that never ran
    // at all, defeating the point of this test.
    const notifications: Array<{ toolNames: string[] | null }> = [];
    const harness = await connectShim(
      dataDir,
      {
        SCRYBE_MCP_LISTCHANGED_POLL_INTERVAL_MS: String(INTERVAL),
        SCRYBE_MCP_LISTCHANGED_POLL_CEILING_MS: String(CEILING),
      },
      {
        capabilities: {},
        listChanged: {
          tools: {
            debounceMs: 0,
            onChanged: (_error, tools) => {
              notifications.push({ toolNames: tools ? tools.map((t) => t.name) : null });
            },
          },
        },
      }
    );

    // Enter degraded — this is the moment the OLD deadline (t0+CEILING) gets
    // set by onModeResolved's fresh-entry branch.
    const t0 = Date.now();
    const initial = await harness.client.listTools();
    expect(initial.tools.map((t) => t.name).sort()).toEqual(["doctor", "init", "status"]);

    // Daemon comes up quickly, well inside the window. Detected via the
    // FIRST notification arriving — this is normal setup (the exact shape
    // Scenario 7 already covers) and establishes that the session really is
    // "healthy" (and _previousModeKind reflects that) before the part of
    // this test that matters.
    daemonA.setHealthy(true);
    await waitUntil(
      () => notifications.some((n) => n.toolNames?.includes("list_projects")),
      WAIT_BUDGET_MS
    );

    // Wait until we're LATE in the OLD window (close to t0+CEILING) before
    // failing — this is the exact shape the bug needs: the epoch that set
    // the deadline ended when we went healthy above, but (pre-fix) the
    // stale deadline VALUE was still sitting there, still nominally
    // unexpired.
    const target = t0 + CEILING - LEFTOVER_MS;
    const toWait = target - Date.now();
    // Finding 9 — a `toWait <= 0` here means setup (process spawn + first
    // notification) already ate the whole CEILING budget, so the deliberate
    // "fail late in the OLD window" timing this test depends on never
    // happens — the daemon-death-and-recovery below would still run, just
    // with no stale deadline left to exercise, silently turning this into a
    // no-op that can never catch the regression it targets. Fail loudly
    // instead of letting that pass unnoticed.
    expect(toWait, `setup consumed the entire ${CEILING}ms CEILING budget before reaching the timing-sensitive wait — raise CEILING or speed up setup`).toBeGreaterThan(0);
    await sleep(toWait);

    // The daemon dies for real. A client call off the cached "healthy" mode
    // fails and hits the D8 invalidation site — the exact place this fix
    // touches.
    await daemonA.close();
    await harness.client.callTool({ name: "list_projects", arguments: {} }).catch(() => { /* expected */ });

    // A real gap before the replacement comes up — several poll intervals'
    // worth — so the poller's first post-failure tick(s) genuinely find the
    // daemon unavailable and record a real "degraded" resolution, exactly
    // as the actual bug's timeline does (the daemon is down for a while,
    // not instantaneously replaced). Skipping this and starting daemonB
    // immediately lets the very first tick resolve straight back to
    // "healthy" with an UNCHANGED tool signature — which the MINOR 5 fix
    // correctly and deliberately stays silent about, so the test would
    // observe no notification for the wrong reason.
    await sleep(RECOVERY_GAP_MS);

    // The daemon comes back on a new port — but from THIS point on the test
    // makes no more handler calls of any kind. Recovery can only be
    // discovered by the background poller re-arming itself off the
    // invalidation site above and actually ticking through to a real
    // resolution, well past where the stale OLD deadline (LEFTOVER_MS left
    // when we failed) would have killed it.
    // Tool list deliberately different from daemonA's — belt-and-suspenders
    // alongside the delay above, so this test's outcome doesn't hinge on
    // winning a timing race against MINOR 5's (correct) unchanged-signature
    // silence either.
    const daemonB = await startFakeDaemon({
      initialHealthy: true,
      tools: [
        { name: "list_projects", description: "List projects", inputSchema: { type: "object", properties: {}, required: [] } },
        { name: "queue_status", description: "Queue status", inputSchema: { type: "object", properties: {}, required: [] } },
      ],
    });
    daemons.push(daemonB);
    writePidfile(dataDir, daemonB.port);

    // No handler call anywhere below this line. Recovery can only be
    // observed via a SECOND push notification — which can only be sent from
    // a real resolveShimMode() completion, which (with nothing else calling
    // getShimMode()) can only be the background poller. Budget comfortably
    // exceeds however much of the OLD (t0+CEILING) window was left when we
    // failed (LEFTOVER_MS): under the bug, the poller dies within its first
    // tick of arming and this never arrives.
    const firstUpgradeCount = notifications.length;
    await waitUntil(() => notifications.length > firstUpgradeCount, WAIT_BUDGET_MS);
    expect(notifications[notifications.length - 1]?.toolNames).toContain("list_projects");
    // Above the 30s file default: this scenario deliberately spends most of
    // CEILING in real time before the part under test even begins.
  }, 60_000);
});

// ─── Scenario 12 — MINOR 6, general case: the invalidation site's poller-arm
// is what lets an idle client recover from a single failing call ──────────
//
// Distinct from Scenario 11 above (which targets the MAJOR fix's specific
// stale-deadline edge case): this is the plain, no-timing-tricks case the
// original MINOR 6 fix was written for. A generous ceiling, no attempt to
// land near any boundary — just: healthy, daemon dies for real, ONE failing
// call, then genuinely idle. If the invalidation site's own
// `startReadinessPollerIfNeeded()` call were missing, nothing would ever
// call getShimMode() again and this would hang forever (bounded here by the
// waitUntil timeout).

describe("runMcpShim e2e — one failing call then idle still recovers via the background poller (fix round MINOR 6)", () => {
  it("a client that calls a tool once after the daemon dies, then goes idle, still gets the real tool surface back", async () => {
    const daemonA = await startFakeDaemon({
      initialHealthy: true,
      tools: [{ name: "list_projects", description: "List projects", inputSchema: { type: "object", properties: {}, required: [] } }],
    });
    daemons.push(daemonA);

    const dataDir = scratchDataDir("idle-recovery-minor6");
    writePidfile(dataDir, daemonA.port);

    const notifications: Array<{ toolNames: string[] | null }> = [];
    const harness = await connectShim(
      dataDir,
      { SCRYBE_MCP_LISTCHANGED_POLL_INTERVAL_MS: "100" },
      {
        capabilities: {},
        listChanged: {
          tools: {
            debounceMs: 0,
            onChanged: (_error, tools) => {
              notifications.push({ toolNames: tools ? tools.map((t) => t.name) : null });
            },
          },
        },
      }
    );

    // Resolve + cache "healthy".
    const initial = await harness.client.listTools();
    expect(initial.tools.map((t) => t.name).sort()).toContain("list_projects");

    // The daemon dies for real.
    await daemonA.close();

    // Exactly ONE failing call — this is what reaches the D8 invalidation
    // site and (with the fix) arms the background poller. No other handler
    // call happens anywhere else in this test. Asserted, not assumed: a call
    // that somehow SUCCEEDED would invalidate nothing, and the recovery
    // waited on below would then be testing nothing.
    const failed = await harness.client.callTool({ name: "list_projects", arguments: {} });
    expect(failed.isError).toBe(true);

    // A real gap before the replacement daemon comes up, several poll
    // intervals' worth, so the poller's own first tick(s) genuinely observe
    // the daemon down and record a real "degraded" resolution first — the
    // actual bug's timeline, not an instant swap. (Starting daemonB with the
    // exact same tool list immediately after the failure would let the very
    // first tick resolve straight back to "healthy" with an unchanged
    // signature, which MINOR 5 correctly stays silent about — the tool list
    // below is ALSO deliberately different from daemonA's, so this test's
    // pass/fail doesn't hinge on winning that timing race either way.)
    await sleep(400);

    // The daemon comes back on a new port, mirroring a restart.
    const daemonB = await startFakeDaemon({
      initialHealthy: true,
      tools: [
        { name: "list_projects", description: "List projects", inputSchema: { type: "object", properties: {}, required: [] } },
        { name: "queue_status", description: "Queue status", inputSchema: { type: "object", properties: {}, required: [] } },
      ],
    });
    daemons.push(daemonB);
    writePidfile(dataDir, daemonB.port);

    // Recovery must be announced via the push notification — the test never
    // calls tools/list again, so this can ONLY be the background poller.
    await waitUntil(
      () => notifications.some((n) => n.toolNames?.includes("list_projects")),
      WAIT_BUDGET_MS
    );
  });
});

// ─── Scenario 13 — MINOR 4: a re-arm attempt after the epoch's deadline has
// already passed does not resume periodic polling ──────────────────────────
//
// The mid-epoch race MINOR 4 (round 1) closed: a poller that has already
// died naturally (its ceiling elapsed, deadline unchanged) must not be
// talked back into periodic polling by a LATER call that still lands
// "degraded" — that call is not a fresh entry into the epoch (the session
// never left "degraded" the whole time), so it must not get a new window.
// Proven behaviourally via health-hit-count growth, same technique as
// Scenario 8: growth up to the ceiling, flatness after, and — the part
// Scenario 8 doesn't cover — flatness STAYS even once one more handler call
// lands after the flatness has already been observed.

describe("runMcpShim e2e — a handler call landing after the ceiling, while still degraded, does not resume polling (fix round MINOR 4)", () => {
  it("does not re-arm the background poller for an epoch that never actually restarted", async () => {
    const daemon = await startFakeDaemon({ initialHealthy: false, tools: [] });
    daemons.push(daemon);

    const dataDir = scratchDataDir("mid-epoch-no-extend");
    writePidfile(dataDir, daemon.port);

    // Finding 5 — same reasoning as Scenario 8: a ceiling several ticks wide,
    // and every wait below timed from when the epoch was armed rather than
    // by accumulating sleeps, so a stall between two steps cannot move where
    // the assertions land relative to the ceiling.
    const INTERVAL = 50;
    const CEILING = 1_000;

    const harness = await connectShim(dataDir, {
      SCRYBE_MCP_LISTCHANGED_POLL_INTERVAL_MS: String(INTERVAL),
      SCRYBE_MCP_LISTCHANGED_POLL_CEILING_MS: String(CEILING),
    });

    // Enter degraded — arms the poller against a CEILING-long deadline.
    const initial = await harness.client.listTools();
    const armedAt = Date.now();
    expect(initial.tools.map((t) => t.name).sort()).toEqual(["doctor", "init", "status"]);

    // Let the ceiling pass and the poller die on its own (mirrors Scenario 8).
    await sleep(Math.max(0, armedAt + CEILING + 500 - Date.now()));
    const hitsAfterCeiling = daemon.healthHitCount();

    // A handler call lands well after the ceiling, daemon STILL down. This
    // is a fresh getShimMode() RESOLUTION, but not a fresh ENTRY into the
    // degraded epoch — the session has been continuously "degraded" the
    // whole time. It pays its own one-off health probe (fine, expected) but
    // must not resume periodic background polling.
    const relisted = await harness.client.listTools();
    expect(relisted.tools.map((t) => t.name).sort()).toEqual(["doctor", "init", "status"]);
    const hitsAfterExtraCall = daemon.healthHitCount();
    expect(hitsAfterExtraCall).toBeGreaterThan(hitsAfterCeiling);

    // No periodic growth should resume after that one-off cost. Several
    // intervals' worth of quiet: a resumed poller would add ~10 hits here.
    await sleep(INTERVAL * 10);
    expect(daemon.healthHitCount()).toBe(hitsAfterExtraCall);
  });
});

// ─── Scenario 14 — MINOR 5: healthy->healthy manifest change notifies,
// unchanged does not ─────────────────────────────────────────────────────
//
// Uses drainNextRpc() to invalidate the cached "healthy" mode WITHOUT the
// daemon ever becoming unreachable — the one shape where the following
// re-resolution can land "healthy" directly, skipping "degraded" entirely,
// which is what makes this the healthy->healthy branch and not the ordinary
// degraded->healthy transition path already covered elsewhere.
//
// Fix round 3 (Finding 10) — Phase 2's `waitUntil` budget (3000ms) can only
// be met if the background readiness poller — armed by the D8 invalidation
// site alongside the cache-clear — ticks at least once inside that window.
// This is the only notification scenario in this file that used to leave
// SCRYBE_MCP_LISTCHANGED_POLL_INTERVAL_MS at its 2000ms default instead of
// overriding it short like every other scenario here, which left the test
// racing that single default-interval tick against its own budget instead of
// actually proving the notification logic.

describe("runMcpShim e2e — healthy->healthy manifest change notifies, unchanged does not (fix round MINOR 5)", () => {
  it("distinguishes a same-signature re-resolution from a real manifest change", async () => {
    const baseTool = { name: "list_projects", description: "List projects", inputSchema: { type: "object", properties: {}, required: [] } };
    const daemon = await startFakeDaemon({ initialHealthy: true, tools: [baseTool] });
    daemons.push(daemon);

    const dataDir = scratchDataDir("healthy-healthy-signature");
    writePidfile(dataDir, daemon.port);

    const notifications: Array<{ toolNames: string[] | null }> = [];
    const harness = await connectShim(
      dataDir,
      { SCRYBE_MCP_LISTCHANGED_POLL_INTERVAL_MS: "100" },
      {
        capabilities: {},
        listChanged: {
          tools: {
            debounceMs: 0,
            onChanged: (_error, tools) => {
              notifications.push({ toolNames: tools ? tools.map((t) => t.name) : null });
            },
          },
        },
      }
    );

    // Baseline: resolves + caches "healthy", establishes the signature
    // onModeResolved compares future healthy->healthy resolutions against.
    const initial = await harness.client.listTools();
    expect(initial.tools.map((t) => t.name).sort()).toEqual(["list_projects"]);

    // Phase 1 — invalidate via a draining RPC failure; the manifest is
    // UNCHANGED. The re-resolution this triggers must land "healthy" again
    // directly (daemon never actually went unreachable) with the SAME tool
    // signature, and must NOT notify.
    daemon.drainNextRpc();
    const drained = await harness.client.callTool({ name: "list_projects", arguments: {} });
    // Finding 5 — assert the precondition rather than assuming it. If the
    // drain did not actually reject this call, nothing was invalidated,
    // nothing re-resolved, and "no notification arrived" below would pass
    // for the wrong reason.
    expect(drained.isError).toBe(true);
    const afterDrain = await harness.client.listTools();
    expect(afterDrain.tools.map((t) => t.name).sort()).toEqual(["list_projects"]);
    // Give any (incorrect) notification time to arrive before asserting its
    // absence.
    await sleep(300);
    expect(notifications.length).toBe(0);

    // Phase 2 — change the manifest, then invalidate again the same way.
    // This time the signature really did change, so it must notify.
    daemon.setTools([baseTool, { name: "queue_status", description: "Queue status", inputSchema: { type: "object", properties: {}, required: [] } }]);
    daemon.drainNextRpc();
    const drainedAgain = await harness.client.callTool({ name: "list_projects", arguments: {} });
    expect(drainedAgain.isError).toBe(true);
    await waitUntil(() => notifications.length > 0, WAIT_BUDGET_MS);
    expect(notifications[notifications.length - 1]?.toolNames).toContain("queue_status");
  });
});

// ─── Scenario 15 — Finding 8: a healthy->degraded downgrade notifies too ──────
//
// Every transition-notifies scenario above is degraded->something (or
// healthy->healthy, Scenario 14). This is the direction fix round 3 found
// missing: a healthy daemon dying mid-session left the client holding its
// last-known tool list (e.g. `list_projects`) with nothing telling it that
// list is now stale — calls off it either fall back in-process (Scenario 5,
// for the status/doctor/init collision) or return error bodies (everything
// else), but the client was never told to stop advertising them. Distinct
// from Scenario 5: that one only checks the CALL resolves correctly; this
// one asserts the NOTIFICATION itself fires, and that it describes what is
// actually being served now (the degraded 3-tool set), not merely that
// SOME notification arrived.

describe("runMcpShim e2e — a healthy->degraded downgrade notifies too (Finding 8)", () => {
  it("the client is told when a live daemon dies, not left holding a stale tool list", async () => {
    const daemon = await startFakeDaemon({
      initialHealthy: true,
      tools: [{ name: "list_projects", description: "List projects", inputSchema: { type: "object", properties: {}, required: [] } }],
    });
    daemons.push(daemon);

    const dataDir = scratchDataDir("healthy-to-degraded-downgrade");
    writePidfile(dataDir, daemon.port);

    const notifications: Array<{ toolNames: string[] | null }> = [];
    const harness = await connectShim(
      dataDir,
      {},
      {
        capabilities: {},
        listChanged: {
          tools: {
            debounceMs: 0,
            onChanged: (_error, tools) => {
              notifications.push({ toolNames: tools ? tools.map((t) => t.name) : null });
            },
          },
        },
      }
    );

    // Resolve + cache "healthy". No notification yet — this is the client's
    // first-ever answer, already accurate, nothing to correct.
    const initial = await harness.client.listTools();
    expect(initial.tools.map((t) => t.name).sort()).toContain("list_projects");
    expect(notifications.length).toBe(0);

    // The daemon dies for real — connections to its port now refuse.
    await daemon.close();

    // One failing call off the stale "healthy" cache reaches the D8
    // invalidation site; the explicit re-list right after is what actually
    // completes the healthy->degraded resolution (same shape as Scenario 5),
    // which is where Finding 8's fix fires the notification.
    await harness.client.callTool({ name: "list_projects", arguments: {} }).catch(() => { /* expected */ });
    const afterDeath = await harness.client.listTools();
    expect(afterDeath.tools.map((t) => t.name).sort()).toEqual(["doctor", "init", "status"]);

    await waitUntil(() => notifications.length > 0, WAIT_BUDGET_MS);
    expect(notifications[notifications.length - 1]?.toolNames?.slice().sort()).toEqual(["doctor", "init", "status"]);
  });
});

// ─── Scenario 16 — a version-skewed session recovers when the daemon is
// restarted on a compatible version (fix round 4, MAJOR 3) ──────────────────
//
// "version-mismatch" and "major-skew" used to be cached for the whole process
// lifetime: neither their CallTool branches nor the poller ever cleared them,
// so a user who did exactly what the mode's own description tells them to do
// (`scrybe daemon restart --force`) was never noticed by the running shim —
// while the docs promise the tool surface upgrades itself. This drives that
// whole sequence and requires the upgrade to arrive with no reconnect and
// without the test calling tools/list again after the restart.

describe("runMcpShim e2e — a version-skewed daemon that gets restarted is picked up (fix round 4)", () => {
  it("upgrades from the version-mismatch trio to the real tool surface, no reconnect", async () => {
    const skewed = await startFakeDaemon({
      initialHealthy: true,
      daemonVersion: "0.33.5", // pre-0.34.0 lancedb boundary
      tools: [{ name: "list_projects", description: "List projects", inputSchema: { type: "object", properties: {}, required: [] } }],
    });
    daemons.push(skewed);

    const dataDir = scratchDataDir("version-mismatch-recovery");
    writePidfile(dataDir, skewed.port);

    const notifications: Array<{ toolNames: string[] | null }> = [];
    const harness = await connectShim(
      dataDir,
      {},
      {
        capabilities: {},
        listChanged: {
          tools: {
            debounceMs: 0,
            onChanged: (_error, tools) => {
              notifications.push({ toolNames: tools ? tools.map((t) => t.name) : null });
            },
          },
        },
      }
    );

    // Precondition: the session really is in the version-mismatch mode.
    const initial = await harness.client.listTools();
    expect(initial.tools.map((t) => t.name).sort()).toEqual(["doctor", "init", "status"]);

    // The user runs `scrybe daemon restart --force`, exactly as this mode's
    // description tells them to: the old daemon goes away and a compatible
    // one comes up on a new port.
    await skewed.close();
    const upgraded = await startFakeDaemon({
      initialHealthy: true,
      tools: [{ name: "list_projects", description: "List projects", inputSchema: { type: "object", properties: {}, required: [] } }],
    });
    daemons.push(upgraded);
    writePidfile(dataDir, upgraded.port);

    // No further handler call from the test: the background poller has to
    // notice. Under the bug, the cached "version-mismatch" mode was terminal
    // and the poller was stopped for it, so this never arrives.
    await waitUntil(
      () => notifications.some((n) => n.toolNames?.includes("list_projects")),
      WAIT_BUDGET_MS
    );

    const relisted = await harness.client.listTools();
    expect(relisted.tools.map((t) => t.name)).toContain("list_projects");
  });
});
