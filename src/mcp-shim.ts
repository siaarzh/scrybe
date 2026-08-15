import { hostname } from "node:os";
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
} from "@modelcontextprotocol/sdk/types.js";
import { VERSION, readScrybeConfig } from "./config.js";
import { DaemonClient, ensureRunning, DAEMON_COLD_START_WAIT_MS } from "./daemon/client.js";
import { readPidfile } from "./daemon/pidfile.js";
import { KNOWN_TOOL_NAMES } from "./tools/tool-names.js";
import { compareSemVer, getMajorVersion } from "./util/semver-compare.js";

// ─── Version boundary for lancedb upgrade comms ───────────────────────────────

const LANCEDB_UPGRADE_BOUNDARY = "0.34.0";

/**
 * Returns true when `version` is strictly less than the lancedb upgrade boundary
 * (0.34.0).  Used to detect a daemon still running the pre-upgrade lancedb.
 */
function isDaemonPreUpgrade(daemonVersion: string): boolean {
  const cmp = compareSemVer(daemonVersion, LANCEDB_UPGRADE_BOUNDARY);
  return cmp !== null && cmp < 0;
}

/**
 * Returns true when `version` is at or above the lancedb upgrade boundary.
 */
function isShimPostUpgrade(shimVersion: string): boolean {
  const cmp = compareSemVer(shimVersion, LANCEDB_UPGRADE_BOUNDARY);
  return cmp !== null && cmp >= 0;
}

// ─── Types mirrored from mcp-rpc (no cross-import into daemon internals) ──────

interface ManifestTool {
  name: string;
  description: string;
  inputSchema: unknown;
  annotations?: unknown;
}

interface McpManifest {
  daemon_version: string;
  tools: ManifestTool[];
}

interface RpcSuccess {
  id: unknown;
  result: unknown;
}

interface RpcError {
  id: unknown;
  error: { code: number; message: string };
}

// ─── Mutable base URL (D1 — resolves per-call, refreshed on failure + heartbeat) ─

let _baseUrl = "";

/**
 * Re-reads the pidfile and updates `_baseUrl` if a valid port is found.
 * Returns the resolved URL, or the last-known value if the pidfile is missing
 * or unparseable (never overwrites with empty — guard against mid-restart window).
 */
function resolveBaseUrl(): string {
  const pidData = readPidfile();
  if (pidData?.port) {
    _baseUrl = `http://127.0.0.1:${pidData.port}`;
  }
  return _baseUrl;
}

// ─── Module-level version skew state (recomputed after successful re-resolve) ──

let _currentSkew: VersionSkewState | null = null;

// ─── Heartbeat (mirrors mcp-server.ts pattern) ────────────────────────────────

const _clientId = `${hostname()}:${process.pid}:${Date.now()}`;
const HEARTBEAT_MS = parseInt(process.env["SCRYBE_DAEMON_HEARTBEAT_MS"] ?? "30000", 10);
let _heartbeatInterval: ReturnType<typeof setInterval> | null = null;
let _unregisterCalled = false;

async function _sendHeartbeat(): Promise<void> {
  // D2: opportunistically update _baseUrl from pidfile on every heartbeat tick
  const pidData = readPidfile();
  if (pidData?.port) {
    _baseUrl = `http://127.0.0.1:${pidData.port}`;
  }
  const url = _baseUrl;
  if (!url) return;
  try {
    // lgtm[js/file-access-to-http] -- loopback only; port from pidfile owned by current user
    await fetch(`${url}/clients/heartbeat`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ clientId: _clientId, pid: process.pid }),
      signal: AbortSignal.timeout(3000),
    });
  } catch { /* daemon not up yet — silent */ }
}

function _startHeartbeatLoop(): void {
  process.stdin.on("end", () => { _unregisterAndExit().catch(() => {}); });
  process.stdout.on("error", () => { _unregisterAndExit().catch(() => {}); });

  _sendHeartbeat().catch(() => {});

  _heartbeatInterval = setInterval(() => {
    _sendHeartbeat().catch(() => {});
  }, HEARTBEAT_MS);
  _heartbeatInterval.unref?.();
}

async function _unregisterAndExit(): Promise<void> {
  if (_unregisterCalled) return;
  _unregisterCalled = true;

  if (_heartbeatInterval) { clearInterval(_heartbeatInterval); _heartbeatInterval = null; }

  try {
    const pidData = readPidfile();
    if (pidData?.port) {
      // lgtm[js/file-access-to-http] -- loopback only; port from pidfile owned by current user
      await fetch(`http://127.0.0.1:${pidData.port}/clients/unregister`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ clientId: _clientId }),
        signal: AbortSignal.timeout(2000),
      });
    }
  } catch { /* best-effort */ }

  process.exit(0);
}

// ─── RPC helper ───────────────────────────────────────────────────────────────

function textResult(text: string) {
  return { content: [{ type: "text" as const, text }] };
}

function jsonResult(data: unknown) {
  return textResult(JSON.stringify(data, null, 2));
}

/**
 * Builds the CallTool response for a failed `callRpc` (Plan 94 Decision 4 —
 * "scope bomb"). `_singleRpc` already attaches `rpcCode` (the daemon's JSON-RPC
 * error code, e.g. -32602 INVALID_PARAMS for caller-facing errors, -32603 for
 * masked internal faults) to the thrown Error; this handler previously read
 * only `err.message` and dropped both the code and `isError`, so a classified
 * -32602 message never reached the calling agent. The daemon has already done
 * the classification (echoed message for caller-facing, masked "internal
 * error" otherwise) — this just needs to mark the MCP result as an error so
 * the agent doesn't mistake either for a successful call.
 */
function callToolErrorResult(err: unknown): { content: { type: "text"; text: string }[]; isError: true } {
  const message = err instanceof Error ? err.message : String(err);
  return { ...jsonResult({ error: message }), isError: true };
}

/** D3 — connect-class error codes that justify a retry (request never reached daemon). */
const CONNECT_CLASS_CODES = new Set(["ECONNREFUSED", "ENOTFOUND", "EHOSTUNREACH"]);

/**
 * Returns true when the error is a connection-class failure (request never
 * reached the daemon, so retrying is safe even for non-idempotent RPCs).
 */
function isConnectClassError(err: unknown): boolean {
  if (!(err instanceof Error)) return false;
  const cause = (err as { cause?: unknown }).cause;
  if (cause && typeof cause === "object" && "code" in cause) {
    return CONNECT_CLASS_CODES.has((cause as { code: string }).code);
  }
  return false;
}

/**
 * A 503 carrying `draining: true` means the daemon is finishing in-flight work
 * and going away; a replacement can be spawned. Treat it exactly like a
 * connect-class failure so `callRpc` re-resolves / respawns instead of
 * rethrowing an opaque `daemon RPC returned HTTP 503` at the agent (review G1:
 * recovery from a drain-time 503 was structurally unreachable, because
 * `isConnectClassError` only ever matches an errno on `err.cause.code`).
 */
function isDrainingError(err: unknown): boolean {
  return err instanceof Error && (err as { daemonDraining?: boolean }).daemonDraining === true;
}

async function _singleRpc(url: string, method: string, params: Record<string, unknown>): Promise<unknown> {
  const id = Math.random().toString(36).slice(2);
  // lgtm[js/file-access-to-http] -- loopback only; port from pidfile owned by current user
  const res = await fetch(`${url}/mcp/rpc`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "X-Scrybe-Client-Id": _clientId,
    },
    body: JSON.stringify({ id, method, params }),
    signal: AbortSignal.timeout(30000),
  });

  if (!res.ok) {
    // Tag a drain-time 503 so callRpc can recover from it (see isDrainingError).
    let draining = false;
    if (res.status === 503) {
      try { draining = ((await res.json()) as { draining?: boolean })?.draining === true; } catch { /* body not JSON */ }
    }
    throw Object.assign(
      new Error(`daemon RPC returned HTTP ${res.status}`),
      draining ? { daemonDraining: true } : {},
    );
  }

  const data = (await res.json()) as RpcSuccess | RpcError;

  if ("error" in data && data.error) {
    const e = data.error;
    throw Object.assign(new Error(e.message), { rpcCode: e.code });
  }

  const result = (data as RpcSuccess).result;

  if (result && typeof result === "object" && "jobId" in (result as object)) {
    const jr = result as { jobId: string; awaitable?: Promise<unknown> };
    if (jr.awaitable) {
      return await jr.awaitable;
    }
    return { job_id: jr.jobId, status: "started" };
  }

  return result;
}

/**
 * After a successful re-resolve to a new port, fetch /health and recompute
 * version skew state (D4). Stored in _currentSkew for subsequent calls.
 * If the health check fails or yields a major-skew, _currentSkew is updated
 * accordingly — callers check _currentSkew after calling this.
 *
 * Plan 121 D9 — what a callRpc port re-resolve does to the TOOL LIST: nothing,
 * deliberately. This function only refreshes `_currentSkew`; it does not touch
 * `_cachedMode` or fire a listChanged notification. A port change here means
 * the OLD port stopped answering but the NEW one, found by re-reading the
 * pidfile, DID answer this same RPC — i.e. the daemon is still alive from the
 * client's point of view, just reachable at a different address (a restart
 * that landed on a new port). Re-fetching the manifest and diffing it against
 * the cached one to decide whether to notify would mean resolveShimMode()'s
 * full network round-trip on the hot path of every RPC retry, to cover a case
 * (the new daemon's tool manifest actually differing from the old one) that
 * is possible but not the common shape of a same-process restart. The cached
 * "healthy" mode's tool list is left as-is. The path that DOES re-resolve and
 * re-arm the notification is the one already wired for D8: when a port
 * re-resolve additionally FAILS (old port dead, new port also unreachable),
 * callRpc's caller (CallTool's healthy branch) sees a connect-class error,
 * invalidates `_cachedMode`, and the next handler call resolves fresh through
 * `onModeResolved` below like any other degraded->healthy transition.
 */
async function _recomputeSkewFromHealth(url: string): Promise<void> {
  try {
    // lgtm[js/file-access-to-http] -- loopback only; port from pidfile owned by current user
    const healthRes = await fetch(`${url}/health`, { signal: AbortSignal.timeout(5000) });
    if (healthRes.ok) {
      const health = (await healthRes.json()) as { version?: string };
      const daemonVersion = health.version ?? "";
      _currentSkew = analyzeVersionSkew(daemonVersion, VERSION);
    }
  } catch { /* health fetch failed — keep existing skew state */ }
}

async function callRpc(
  method: string,
  params: Record<string, unknown>
): Promise<unknown> {
  const url = _baseUrl || resolveBaseUrl();

  try {
    return await _singleRpc(url, method, params);
  } catch (firstErr) {
    // D3: only retry for connect-class errors (request never reached daemon),
    // plus a drain-time 503 (review G1 — the daemon is going away and a
    // replacement can serve the call).
    if (!isConnectClassError(firstErr) && !isDrainingError(firstErr)) throw firstErr;

    // Re-resolve from pidfile
    const newUrl = resolveBaseUrl();
    const portChanged = newUrl !== url && !!newUrl;

    if (portChanged) {
      // Retry against new port
      try {
        const result = await _singleRpc(newUrl, method, params);
        // Successful — recompute skew from new daemon's health (D4)
        await _recomputeSkewFromHealth(newUrl);
        return result;
      } catch (_retryErr) {
        // New port also failed — fall through to ensureRunning
      }
    }

    // Port unchanged or retry failed: try ensureRunning (5s per D3)
    try {
      const spawnResult = await ensureRunning(5000);
      if (spawnResult.ok) {
        // Re-resolve one more time after spawn
        const spawnUrl = resolveBaseUrl();
        if (spawnUrl) {
          const result = await _singleRpc(spawnUrl, method, params);
          await _recomputeSkewFromHealth(spawnUrl);
          return result;
        }
      }
    } catch { /* spawn failed — fall through to error */ }

    throw firstErr;
  }
}

// ─── Version skew helpers ────────────────────────────────────────────────────

interface VersionSkewState {
  isMajorSkew: boolean;
  isMinorOrPatchSkew: boolean;
  isPreUpgradeBoundary: boolean;
  allowedTools: Set<string>;
}

function analyzeVersionSkew(daemonVersion: string, shimVersion: string): VersionSkewState {
  const cmp = compareSemVer(daemonVersion, shimVersion);
  if (cmp === null) {
    return { isMajorSkew: false, isMinorOrPatchSkew: false, isPreUpgradeBoundary: false, allowedTools: new Set(KNOWN_TOOL_NAMES) };
  }

  const daemonMajor = getMajorVersion(daemonVersion);
  const shimMajor = getMajorVersion(shimVersion);

  const isMajorSkew = daemonMajor !== null && shimMajor !== null && daemonMajor !== shimMajor;
  const isMinorOrPatchSkew = !isMajorSkew && cmp !== 0;
  const isPreUpgradeBoundary = isShimPostUpgrade(shimVersion) && isDaemonPreUpgrade(daemonVersion);

  return {
    isMajorSkew,
    isMinorOrPatchSkew,
    isPreUpgradeBoundary,
    allowedTools: new Set(KNOWN_TOOL_NAMES),
  };
}

// ─── Daemon-unavailable detection ─────────────────────────────────────────────

type DaemonUnavailableVariant = "no-pidfile" | "daemon-dead" | "mid-restart" | "daemon-version-mismatch";

interface DaemonUnavailableState {
  variant: DaemonUnavailableVariant;
  description: string;
}

async function detectDaemonUnavailable(): Promise<DaemonUnavailableState | null> {
  const client = DaemonClient.fromPidfile();

  if (!client) {
    return {
      variant: "no-pidfile",
      description:
        "Run: scrybe daemon install   (then reconnect)\n" +
        "\n" +
        "scrybe MCP requires a running daemon. The above sets up autostart so the daemon is ready before the next MCP probe.\n" +
        "\n" +
        "Alternatively, if the daemon is already installed:\n" +
        "  scrybe daemon start",
    };
  }

  try {
    await client.health();
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    const isConnectionRefused =
      message.includes("ECONNREFUSED") ||
      message.includes("returned 503") ||
      message.includes("connection");

    if (message.includes("returned 503") || message.includes("503")) {
      return {
        variant: "mid-restart",
        description:
          "Run: scrybe daemon restart\n" +
          "\n" +
          "The daemon is running but temporarily unavailable (mid-restart or overloaded). Restarting will bring it back online.\n" +
          "\n" +
          "Alternatively, reconnect in a few seconds — the daemon should recover on its own.",
      };
    }

    if (isConnectionRefused) {
      return {
        variant: "daemon-dead",
        description:
          "Run: scrybe daemon start   (then reconnect)\n" +
          "\n" +
          "The daemon is configured but not running. The above will start it.\n" +
          "\n" +
          "Alternatively, if the daemon is not yet installed:\n" +
          "  scrybe daemon install",
      };
    }

    return {
      variant: "daemon-dead",
      description:
        "Run: scrybe daemon start   (then reconnect)\n" +
        "\n" +
        "The daemon is configured but not responding. Restart it to reconnect.\n" +
        "\n" +
        "Alternatively, if the daemon is not yet installed:\n" +
        "  scrybe daemon install",
    };
  }

  return null;
}

// ─── Degraded-mode tool implementations (shim-native, no daemon required) ────

/**
 * Shim-native `status` — computes state locally when the daemon is unavailable.
 * Returns config_present, daemon_running:false, and provider info from config.
 */
async function degradedStatus(): Promise<unknown> {
  const { VERSION: ver } = await import("./config.js");
  const { configuredEmbeddingStatus } = await import("./embedding-status.js");
  const embeddingStatus = configuredEmbeddingStatus();
  return {
    version: ver,
    daemon_running: false,
    daemon_pid: null,
    daemon_port: null,
    daemon_version: null,
    ...embeddingStatus,
    setup_guide: "Run the scrybe 'setup' skill for a guided first-run walkthrough (status -> doctor -> init -> poll reindex_status). Non-skill clients: follow each tool's `remedy` output.",
  };
}

/**
 * Shim-native `doctor` — runs runDoctor() in-process (pure, no daemon needed).
 * The daemon checks will naturally surface daemon_not_running/stale-pidfile.
 */
async function degradedDoctor(section?: string): Promise<unknown> {
  const { runDoctor } = await import("./onboarding/doctor.js");
  const report = await runDoctor();
  const checks = section
    ? report.checks.filter((c) => c.section === section)
    : report.checks;
  const summary = section
    ? checks.reduce(
        (acc, c) => { acc[c.status]++; return acc; },
        { ok: 0, warn: 0, fail: 0, skip: 0 }
      )
    : report.summary;
  return { ...report, checks, summary, healthy: summary.fail === 0 };
}

/**
 * Shim-native `init` (degraded path):
 * 1. Tries to spawn the daemon via ensureRunning().
 * 2. If daemon starts, reports success + advises the user to reconnect.
 * 3. If daemon can't start, reports guidance distinguishing config-missing vs
 *    daemon-dead cases.
 *
 * A full provider-credential init requires a running daemon to submit jobs.
 * This degraded variant handles the startup gate only.
 *
 * The wait is `INIT_DAEMON_START_WAIT_MS` (30s), deliberately NOT
 * `MCP_TOOLS_LIST_WAIT_CEILING_MS` (20s) — see that constant for why the two
 * differ.
 */
async function degradedInit(configPresent: boolean): Promise<unknown> {
  try {
    process.stderr.write("[scrybe-mcp] degraded init: attempting ensureRunning\n");
    const result = await ensureRunning(INIT_DAEMON_START_WAIT_MS);
    if (result.ok) {
      return {
        ok: true,
        status: "daemon_started",
        message:
          "The scrybe daemon has been started. " +
          "Reconnect Claude Code (or your MCP client) to get the full tool surface. " +
          "Then call `init` again with your provider settings to complete configuration.",
      };
    }
  } catch { /* fall through to guidance */ }

  if (!configPresent) {
    return {
      ok: false,
      status: "config_missing",
      message:
        "Scrybe is not configured yet. " +
        "Run `scrybe init` from the command line to walk through provider setup, " +
        "then start the daemon with `scrybe daemon start` and reconnect.",
    };
  }

  return {
    ok: false,
    status: "daemon_unavailable",
    message:
      "Scrybe is configured but the daemon could not be started automatically. " +
      "Run `scrybe daemon start` from the command line, then reconnect to get the full tool surface.",
  };
}

/**
 * Runs the in-process implementation of `status` / `doctor` / `init` by
 * name. Shared by two call sites (Plan 121 D8):
 *   - The "degraded" CallTool branch, where these are the only three tools
 *     that exist at all.
 *   - The "healthy" CallTool branch's failure fallback (see the CallTool
 *     handler below), reached when a daemon that made this session
 *     "healthy" earlier has since stopped answering. Since `status`,
 *     `doctor` and `init` are also real daemon tool names
 *     (`src/tools/tool-names.ts`), a client holding a stale "healthy" list
 *     can call one after the daemon just died — that call must resolve to
 *     THIS implementation, not surface a raw connection error for a tool
 *     the client believes is real.
 *
 * `configPresent` mirrors what `resolveShimMode()` computes once when it
 * builds a "degraded" mode descriptor; the degraded branch passes that
 * cached value through unchanged (D5 — the degraded tools' behaviour does
 * not change here). The healthy-branch fallback has no such descriptor to
 * read from (its mode is "healthy", not "degraded"), so when the caller
 * omits it, it is computed live the same way `resolveShimMode()` does.
 */
async function runDegradedToolByName(
  name: "status" | "doctor" | "init",
  params: Record<string, unknown>,
  configPresent?: boolean
): Promise<ReturnType<typeof jsonResult>> {
  if (name === "status") {
    try {
      return jsonResult(await degradedStatus());
    } catch (err) {
      return jsonResult({ error: `status failed: ${err instanceof Error ? err.message : String(err)}` });
    }
  }

  if (name === "doctor") {
    try {
      return jsonResult(await degradedDoctor(params["section"] as string | undefined));
    } catch (err) {
      return jsonResult({ error: `doctor failed: ${err instanceof Error ? err.message : String(err)}` });
    }
  }

  // name === "init"
  let present = configPresent;
  if (present === undefined) {
    present = false;
    try {
      present = readScrybeConfig() !== null;
    } catch { /* best-effort; defaults to false */ }
  }
  try {
    return jsonResult(await degradedInit(present));
  } catch (err) {
    return jsonResult({ error: `init failed: ${err instanceof Error ? err.message : String(err)}` });
  }
}

// ─── Degraded tool specs (used by the "degraded" ShimMode branch below) ───────

function buildDegradedTools(configPresent: boolean) {
  const statusDesc = configPresent
    ? "Return a quick scrybe status snapshot. The daemon is currently unavailable — " +
      "this shim-local snapshot shows config_present:true with daemon_running:false. " +
      "To restore full tool access, run `scrybe daemon start` and reconnect."
    : "Return a quick scrybe status snapshot. Scrybe is not yet configured — " +
      "run `scrybe init` from the command line to set up a provider, then reconnect.";

  return [
    {
      name: "status",
      description: statusDesc,
      inputSchema: { type: "object", properties: {}, required: [] },
    },
    {
      name: "doctor",
      description:
        "Run a full scrybe health check in-process (no daemon needed). " +
        "Reports configuration state, embedding provider validity, data integrity, " +
        "and daemon status. Each check includes an optional `remedy` field. " +
        "Use `section` to filter (e.g. 'Daemon', 'Embedding Provider').",
      inputSchema: {
        type: "object",
        properties: {
          section: {
            type: "string",
            description: "Optional section filter (e.g. 'Daemon', 'Embedding Provider').",
          },
        },
        required: [],
      },
    },
    {
      name: "init",
      description: configPresent
        ? "Attempt to start the scrybe daemon and guide reconnection. " +
          "Scrybe is configured but the daemon is not running. " +
          "Calling this tool will try to auto-start the daemon. " +
          "If successful, reconnect Claude Code to get the full tool surface."
        : "Guide scrybe initial setup. " +
          "Scrybe is not yet configured — this tool returns setup instructions. " +
          "Run `scrybe init` from the command line, then restart the daemon and reconnect.",
      inputSchema: { type: "object", properties: {}, required: [] },
    },
  ] as const;
}

// ─── Shim mode (Plan 121 D3 — one Server instance, a branching handler) ───────
//
// resolveShimMode() itself walks the same four modes, in the same order and
// with the same module-level side effects (_baseUrl, _currentSkew,
// console.warn), as the pre-refactor runMcpShim() body did — that part of
// the claim below holds. It does NOT mean the SERVED behaviour of every mode
// was preserved: an independent blind review (fix round, 2026-08) found that
// the initial cut of this refactor had silently regressed the
// "version-mismatch" mode from HEAD's always-built 3-tool degraded set down
// to a bare 1-tool placeholder shared with "major-skew" — a real behaviour
// change this comment's original wording would have read past. That has
// been corrected (see the "Fix round (MAJOR 1)" comments below); read the
// bullets in this block as describing resolveShimMode()'s bookkeeping only,
// not as a blanket guarantee that nothing downstream of it changed.
// What has changed across slices 2-3:
//   - Slice 2 stopped constructing a Server per branch. resolveShimMode()
//     returns a plain descriptor that the one Server's handlers close over
//     and switch on.
//   - Slice 3 (this one) stopped calling resolveShimMode() from
//     runMcpShim() at startup — `initialize` must be answered with no
//     daemon work at all. Resolution now happens lazily, inside the
//     handlers, via getShimMode() below, which also caches a terminal
//     result and gates the one-time ensureRunning() spawn attempt so
//     repeated tools/list calls don't repeat it.
//   - Slice 4 (this one) made CallTool resolve per tool NAME instead of
//     trusting the mode alone (the status/doctor/init collision, D8): the
//     "healthy" branch below now falls back to the in-process
//     implementation (runDegradedToolByName) when a forward to the daemon
//     fails with a connect-class/draining error, and invalidates the
//     cached terminal mode so the NEXT getShimMode() call re-resolves for
//     real instead of continuing to report "healthy" forever.

interface DegradedMode {
  kind: "degraded";
  unavailable: DaemonUnavailableState;
  tools: ReturnType<typeof buildDegradedTools>;
  configPresent: boolean;
}

interface VersionMismatchMode {
  kind: "version-mismatch";
  description: string;
  // Fix round (MAJOR 1) — at HEAD, serveUnavailableServer() ALWAYS built the
  // 3-tool degraded set for every "unavailable" server it constructed,
  // including the lancedb-boundary one; `description` was only ever used as
  // the CallTool fallback for a name outside {status, doctor, init}. The
  // initial D3/D6 refactor collapsed this mode into major-skew's single-tool
  // arm instead, silently dropping working in-process status/doctor/init for
  // a shim>=0.34.0-vs-daemon<0.34.0 session. These two fields restore parity.
  tools: ReturnType<typeof buildDegradedTools>;
  configPresent: boolean;
}

interface MajorSkewMode {
  kind: "major-skew";
  description: string;
}

interface HealthyMode {
  kind: "healthy";
  filteredTools: ManifestTool[];
}

type ShimMode = DegradedMode | VersionMismatchMode | MajorSkewMode | HealthyMode;

/**
 * Fires the auto-spawn attempt inside resolveShimMode() at most ONCE per
 * process. Without this, a client that polls tools/list in a loop while the
 * daemon is cold (exactly what the degraded-mode re-probe below invites)
 * would re-run ensureRunning() — and therefore re-incur up to
 * COLD_START_WAIT_MS of wait — on every single call.
 *
 * Fix round (MAJOR 2) — this must latch on the very FIRST call to
 * resolveShimMode(), whether or not that call actually found the daemon
 * unavailable. The original code only ever set this true from inside the
 * `unavailable && ...` branch below, so a session that resolved healthy on
 * its first call (the common case) left the flag false for the rest of the
 * process. Concretely: warm session → the daemon is running fine → the user
 * deliberately runs `scrybe daemon stop` → the next tool call fails
 * connect-class, invalidates the cached mode (see the CallTool healthy
 * branch below) → the NEXT getShimMode() re-resolves, finds the daemon
 * unavailable for the first time this process has ever observed that, and
 * — with the bug — treats it as its first-ever chance to auto-spawn,
 * respawning the daemon the user just deliberately stopped, and blocking
 * the call for up to COLD_START_WAIT_MS while it does. Setting the latch
 * unconditionally at the top of every resolveShimMode() call closes that:
 * by the time this function can ever be called a second time, the flag is
 * already true.
 *
 * Scope of the guarantee, stated here so it is not overread: this latch
 * governs resolveShimMode()'s auto-spawn ONLY. `callRpc` independently
 * calls ensureRunning() on its connect-class retry path before rethrowing,
 * and does not consult this flag — so a deliberately stopped daemon can
 * still be respawned by that call. Closing that half is a separate change.
 */
let _ensureAttempted = false;

/**
 * Resolves which of the four modes this session is in. Identical control
 * flow to the pre-refactor `runMcpShim` body: same detection order, same
 * `ensureRunning` retry, same module-level state writes (`_baseUrl`,
 * `_currentSkew`), same `console.warn` on minor/patch skew. The only
 * differences (Plan 121 slice 3): each branch returns a descriptor instead
 * of building and connecting its own `Server`, and the `ensureRunning` spawn
 * attempt is gated to run at most once per process (see `_ensureAttempted`)
 * since this function can now be called repeatedly by getShimMode() below.
 */
async function resolveShimMode(): Promise<ShimMode> {
  // Fix round (MAJOR 2) — latch BEFORE the check below, unconditionally, so
  // a warm first resolution closes the auto-spawn window exactly as a cold
  // one does. See the doc comment on `_ensureAttempted` above.
  const alreadyAttemptedSpawn = _ensureAttempted;
  _ensureAttempted = true;

  let unavailable = await detectDaemonUnavailable();
  if (unavailable && COLD_START_WAIT_MS > 0 && !alreadyAttemptedSpawn) {
    // On a true cold start (PC reboot, no autostart installed), the daemon won't
    // be running at all — polling alone would just time out and serve the 1-tool
    // placeholder. ensureRunning() reuses the CLI's auto-spawn path: it checks
    // liveness, spawns the daemon via spawnDaemonDetached (VBS launcher on
    // Windows → no console flash), and polls /health until ready or deadline.
    // Honours SCRYBE_NO_AUTO_DAEMON / containerised environments by returning
    // immediately with a non-spawn reason.
    process.stderr.write(`[scrybe-mcp] daemon not ready (${unavailable.variant}) — attempting auto-start (up to ${COLD_START_WAIT_MS}ms)\n`);
    const ensureResult = await ensureRunning(COLD_START_WAIT_MS);
    if (ensureResult.ok) {
      unavailable = null;
    } else {
      // Re-probe so the placeholder server's recovery message matches the
      // current state (e.g. spawn-failed → daemon-dead variant).
      unavailable = await detectDaemonUnavailable();
    }
  }

  if (unavailable) {
    // Compute config-present once at mode-resolution time (synchronous).
    // We need it to differentiate status/init descriptions.
    let configPresent = false;
    try {
      // readScrybeConfig is synchronous; statically imported (ESM — no require()).
      configPresent = readScrybeConfig() !== null;
    } catch { /* best-effort; defaults to false */ }

    return { kind: "degraded", unavailable, tools: buildDegradedTools(configPresent), configPresent };
  }

  const pidData = readPidfile();
  const port = pidData!.port;
  // D1: initialise module-level _baseUrl from the pidfile port at startup
  _baseUrl = `http://127.0.0.1:${port}`;

  // lgtm[js/file-access-to-http] -- loopback only; port from pidfile owned by current user
  const manifestRes = await fetch(`${_baseUrl}/mcp/manifest`, {
    signal: AbortSignal.timeout(5000),
  });

  if (!manifestRes.ok) {
    throw new Error(`failed to fetch daemon manifest: HTTP ${manifestRes.status}`);
  }

  const manifest = (await manifestRes.json()) as McpManifest;
  const daemonVersion = manifest.daemon_version || "";

  // ── lancedb upgrade boundary: shim >= 0.34.0, daemon < 0.34.0 ──────────────
  if (isShimPostUpgrade(VERSION) && isDaemonPreUpgrade(daemonVersion)) {
    // Fix round (MAJOR 1) — compute configPresent the same way the "degraded"
    // branch above does, so this mode can serve the same working in-process
    // status/doctor/init that HEAD's serveUnavailableServer() always built,
    // regardless of variant.
    let configPresent = false;
    try {
      configPresent = readScrybeConfig() !== null;
    } catch { /* best-effort; defaults to false */ }

    return {
      kind: "version-mismatch",
      description:
        "Run: scrybe daemon restart --force   (then reconnect)\n" +
        "\n" +
        "scrybe v0.34.0 upgraded lancedb. The running daemon is still on the old version\n" +
        "and cannot use the new on-disk format helpers. Stop + start refreshes the daemon\n" +
        "with the new lancedb binary. Existing data is preserved (lancedb 0.27 reads\n" +
        "0.14-written tables transparently).\n" +
        "\n" +
        "If the stop command fails with EPERM on Windows, close all Claude Code / IDE\n" +
        "sessions first — they hold the lancedb native binding open.",
      tools: buildDegradedTools(configPresent),
      configPresent,
    };
  }

  // D4/D10: store initial skew in module-level state; callRpc may refresh it
  // after re-resolve. Use the local `skew` const for the reads in THIS
  // function (below) rather than re-reading the module binding through a
  // non-null assertion — TS cannot narrow a module-level `let` across
  // function calls, and the assertion was only ever sound because nothing
  // reassigned it between here and the read. `_currentSkew` itself stays a
  // plain nullable module binding; CallTool's healthy branch reads it
  // directly (D10) since it must also tolerate being the FIRST handler to
  // trigger resolution.
  const skew = analyzeVersionSkew(daemonVersion, VERSION);
  _currentSkew = skew;

  if (skew.isMajorSkew) {
    return {
      kind: "major-skew",
      description: `daemon version ${daemonVersion} is major-incompatible with shim ${VERSION}. Restart to update: scrybe daemon restart`,
    };
  }

  if (skew.isMinorOrPatchSkew) {
    console.warn(
      `[scrybe] daemon version ${daemonVersion} differs from shim ${VERSION} (minor/patch) — restart daemon to refresh tool surface`
    );
  }

  const filteredTools = manifest.tools.filter((t) => skew.allowedTools.has(t.name));
  return { kind: "healthy", filteredTools };
}

// ─── Main shim entrypoint ─────────────────────────────────────────────────────

/**
 * Ceiling for the daemon-resolution wait now performed lazily inside the
 * handlers (see `getShimMode` / `resolveShimMode` above), not at startup.
 *
 * Plan 121 D1. This USED to be clamped by `MAX_SPAWN_LOCK_HOLD_MS`
 * (60_000ms, src/daemon/data-dir-lock.ts) — a bound on how long a spawn
 * LOCK may be held, which is a correctness concern for `ensureRunning()`'s
 * cross-process spawn serialisation and says nothing about how long an MCP
 * client will wait for a tool list. Reusing it meant a user raising
 * `SCRYBE_MCP_COLD_START_WAIT_MS` to the permitted max (60s) landed within
 * 2x of the client's measured `tools/list` cliff (90s of stall was fine,
 * 120s silently dropped every tool with no error anywhere) — the exact
 * failure this plan exists to close, reachable again at a higher threshold.
 *
 * 20s is deliberately NOT derived from that cliff either. D1's amendment is
 * explicit that treating an undocumented client internal as headroom is the
 * mistake to avoid — it shipped four versions in five days and can move
 * without notice. This ceiling is a UX bound chosen for reasons of its own:
 * comfortably above the 15s default (`DAEMON_COLD_START_WAIT_MS`) so the
 * common case is never clamped, and comfortably below every measured
 * client boundary so a user-raised override can never approach one.
 */
export const MCP_TOOLS_LIST_WAIT_CEILING_MS = 20_000;

/**
 * How long `init` waits for the daemon it just asked to start (see
 * `degradedInit`). Deliberately LONGER than the ceiling above, and
 * deliberately a separate constant.
 *
 * The ceiling above bounds a PASSIVE wait: nobody asked for it, the client is
 * blocked on a tool list it expects instantly, and giving up early is cheap
 * because the surface upgrades itself the moment the daemon answers. `init`
 * is the opposite on every count — the user invoked it, its entire purpose is
 * "cold-start the daemon", and that is precisely the path that has to load
 * the lancedb native binding, the one step with a plausible claim on the
 * longer budget. Nothing has ever measured that a 20s budget is enough for
 * it, so this keeps the 30s it has always had rather than trading a measured
 * default for an unmeasured one to remove a second number.
 */
const INIT_DAEMON_START_WAIT_MS = 30_000;

/**
 * Cold-start budget handed to `ensureRunning()` from inside the handler.
 * Clamped to `MCP_TOOLS_LIST_WAIT_CEILING_MS` (see above), not
 * `MAX_SPAWN_LOCK_HOLD_MS`.
 */
const COLD_START_WAIT_MS = (() => {
  const raw = parseInt(process.env["SCRYBE_MCP_COLD_START_WAIT_MS"] ?? "", 10);
  const requested = Number.isFinite(raw) && raw >= 0 ? raw : DAEMON_COLD_START_WAIT_MS;
  return Math.min(requested, MCP_TOOLS_LIST_WAIT_CEILING_MS);
})();

/**
 * Plan 121 slice 3 (D2) — lazy, cached, coalesced daemon-mode resolution.
 *
 * `initialize` must be answered with no daemon work at all, so nothing here
 * runs until the first handler call that needs a mode (ListTools or
 * CallTool — whichever lands first; see D10 above). Three concerns beyond
 * "just call resolveShimMode()":
 *
 *   - Repeated calls must not repeat expensive work. Only "healthy" is
 *     cached and reused — no repeat manifest fetch — and even that is
 *     invalidated when a call fails connect-class, so it means "not
 *     re-resolved on every call", not "never re-resolved". Every OTHER mode
 *     re-resolves on each call, so a daemon that becomes usable later is
 *     picked up on the next list/call (this is what makes the cold-then-ready
 *     scenario pass without the push-notification machinery that is Phase 5's
 *     job, not this slice's).
 *
 *     Fix round 4 — "version-mismatch" and "major-skew" used to be cached
 *     for the whole process lifetime alongside "healthy", and neither their
 *     CallTool branches nor the poller ever cleared that. A user on a
 *     pre-0.34.0 daemon who did exactly what the mode's own description told
 *     them to do (`scrybe daemon restart --force`) was therefore never
 *     noticed by the running shim: the restarted, compatible daemon stayed
 *     invisible for the rest of the process, while the docs said the tool
 *     surface upgrades itself. Both are recoveries from "the daemon is not
 *     serving us", exactly like "degraded", and they now recover the same
 *     way. The cost is one health check plus one manifest fetch per handler
 *     call while skewed — the same shape "degraded" has always paid, and
 *     only while the session is in a state where nothing else works anyway.
 *
 *     The one genuinely expensive/risky step — the `ensureRunning()`
 *     auto-spawn attempt — is separately gated inside `resolveShimMode()`
 *     itself (`_ensureAttempted`) so it fires at most once per process
 *     regardless of how many times this wrapper re-resolves.
 *   - Concurrent callers must not race two resolutions. A ListTools and a
 *     CallTool landing back to back (or two ListTools calls overlapping)
 *     share one in-flight promise rather than each calling
 *     `resolveShimMode()` independently.
 */
let _cachedMode: ShimMode | null = null;
let _resolving: Promise<ShimMode> | null = null;

// ─── Plan 121 D9 — the mode-transition state behind sendToolListChanged() ────
//
// "Send the notification when the daemon becomes ready" is not one event; it
// is a small state machine sitting on top of the mode resolution above:
//
//   - `_server` — the single Server instance (D3/D11), stashed here so this
//     module-level machinery can call `sendToolListChanged()` without
//     threading the instance through every function. Set once, by
//     runMcpShim(), before any handler can run.
//   - `_previousModeKind` — the last mode `onModeResolved` observed. This is
//     what makes ANY change of mode kind (not just "degraded -> anything
//     else") a detectable TRANSITION rather than every resolution being
//     treated as one: `onModeResolved` reassigns it unconditionally at the
//     top of every call, before deciding whether to notify, so a repeat
//     resolution that lands on the SAME kind as last time is never mistaken
//     for a transition — that alone is what stops "ready -> dead -> ready"
//     from notifying more than once per actual change, with no separate
//     has-notified latch needed. `null` until the first resolution ever
//     completes, so that first resolution (which is also the client's
//     first-ever tools/list response, already accurate) never notifies.
//   - `_readinessPollHandle` / `_readinessPollDeadline` — see
//     `startReadinessPollerIfNeeded` below.
let _server: Server | null = null;
let _previousModeKind: ShimMode["kind"] | null = null;
let _readinessPollHandle: ReturnType<typeof setInterval> | null = null;
let _readinessPollDeadline = 0;
// Fix round (MINOR 5) — signature of the tool list actually served the last
// time a "healthy" mode resolved. Lets a healthy->healthy re-resolution (the
// daemon died and came back, or was upgraded, between two calls, without
// this session ever passing through "degraded" in between — so the
// wasDegraded transition check below never fires) still be recognised as a
// real change. See onModeResolved.
let _lastHealthyToolSignature: string | null = null;

/**
 * Stable, order-independent signature of what a "healthy" mode would serve
 * from ListTools (Plan 121 fix round, MINOR 5). Name AND description are
 * included — a daemon restart that changes a tool's description without
 * adding/removing any name is still a real manifest change the client
 * should be told about.
 */
function toolSignature(tools: ManifestTool[]): string {
  return JSON.stringify(
    tools.map((t) => [t.name, t.description]).sort((a, b) => a[0].localeCompare(b[0]))
  );
}

/**
 * Interval between background readiness probes while degraded and idle
 * (Plan 121 D9). Env-overridable, same pattern as `COLD_START_WAIT_MS`, so
 * tests can shrink it instead of waiting on the multi-second default.
 */
const LIST_CHANGED_POLL_INTERVAL_MS = (() => {
  const raw = parseInt(process.env["SCRYBE_MCP_LISTCHANGED_POLL_INTERVAL_MS"] ?? "", 10);
  return Number.isFinite(raw) && raw > 0 ? raw : 2_000;
})();

/**
 * Total wall-clock budget the background readiness poller gets before it
 * gives up (Plan 121 D9 — "what cancels the readiness poller if the daemon
 * never arrives"). The probe this was modelled on (`sdk-server.mjs`) never
 * clears its `setInterval` — fine in a probe that exits with the test, a
 * leak in a long-lived MCP shim process talking to a daemon that may simply
 * never come up (not configured, `SCRYBE_NO_AUTO_DAEMON` set, etc). Past
 * this deadline the poller stops on its own; the session stays degraded
 * until the next handler call re-resolves on demand, exactly as it did
 * before this slice — the poller only ever adds a CHANCE to notify earlier
 * than that, it never removes the handler-driven fallback.
 */
const LIST_CHANGED_POLL_CEILING_MS = (() => {
  const raw = parseInt(process.env["SCRYBE_MCP_LISTCHANGED_POLL_CEILING_MS"] ?? "", 10);
  return Number.isFinite(raw) && raw > 0 ? raw : 5 * 60_000;
})();

function stopReadinessPoller(): void {
  if (_readinessPollHandle) {
    clearInterval(_readinessPollHandle);
    _readinessPollHandle = null;
  }
}

/**
 * Starts the background poller that lets a session notice the daemon coming
 * up WITHOUT a client handler call (Plan 121 D9). Without this, a client
 * that lists once while cold, gets the degraded set, and then sits idle
 * never re-probes — nothing calls getShimMode() again until the client
 * itself calls a handler, which is exactly the gap this slice closes.
 *
 * Idempotent: a second call while a poller is already running for the
 * current non-serving epoch is a no-op, so repeated non-serving resolutions
 * (the poller's own tick, or a client polling tools/list itself) don't stack
 * up multiple intervals.
 *
 * `.unref()`ed so a daemon that never arrives cannot keep the process alive
 * on its own — the poller is allowed to keep ticking in the background, but
 * it must never be the reason the process doesn't exit. The
 * `LIST_CHANGED_POLL_CEILING_MS` deadline below is the separate, unrelated
 * concern of not polling forever even while the process IS alive for other
 * reasons (an interactive MCP session normally is).
 *
 * Fix round (MINOR 4) — this function does NOT set `_readinessPollDeadline`.
 * The deadline belongs to the NON-SERVING EPOCH (owned by onModeResolved's
 * fresh-entry branch below), not to any one interval handle's lifetime.
 * The original code re-derived `Date.now() + LIST_CHANGED_POLL_CEILING_MS`
 * every time this function armed a fresh handle — including a handle
 * recreated mid-epoch. That recreation is a real, reachable race: a tick
 * firing just before the deadline calls `getShimMode()` without awaiting it
 * inline; if the NEXT tick fires before that resolution settles, it sees
 * the (still current) deadline has passed, calls `stopReadinessPoller()`,
 * and clears the handle. When the in-flight resolution FINALLY settles,
 * `onModeResolved` sees the mode is still non-serving and — because the
 * handle is now null — calls back in here, which used to hand out a BRAND
 * NEW deadline extended from `Date.now()`, making the ceiling
 * resurrectable indefinitely. Reading, and never writing, the deadline here
 * closes that: a handle recreated mid-epoch inherits the SAME deadline and
 * dies on its very first tick instead of buying another full window.
 *
 * Fix round 4 (NIT 9) — that first tick is also the ONLY guard needed. An
 * `if (deadline passed) return;` used to sit here as well; a reviewer showed
 * by mutation that deleting it changes no observable behaviour, because the
 * tick-time check below already stops a handle armed past its deadline
 * before it can probe anything. Deleted rather than kept as an untested
 * second copy of the same condition.
 */
function startReadinessPollerIfNeeded(): void {
  if (_readinessPollHandle) return;

  const handle = setInterval(() => {
    if (Date.now() >= _readinessPollDeadline) {
      stopReadinessPoller();
      return;
    }
    // Shares getShimMode()'s own coalescing/caching — this is not a second
    // resolution path, just another caller of the same one. Its `.then()`
    // (onModeResolved, below) is what actually notices a transition.
    getShimMode().catch(() => { /* best-effort — retried next tick */ });
  }, LIST_CHANGED_POLL_INTERVAL_MS);
  handle.unref?.();
  _readinessPollHandle = handle;
}

/**
 * Runs after EVERY resolveShimMode() completion (both handler-triggered and
 * poller-triggered) and is the single place D9's state machine lives.
 *
 *   - Entering a NON-SERVING mode — degraded, version-mismatch or major-skew
 *     — freshly, or re-entering after having left it: arm the epoch deadline
 *     on a fresh entry only, and make sure the poller is running so the
 *     transition back out can be noticed without another client call. All
 *     three share one epoch because all three end the same way: the daemon
 *     starts, or restarts on a version this shim can talk to. A fresh entry
 *     FROM "healthy" also notifies — the client is holding a tool list that
 *     no longer matches what is actually being served (fix round 3 /
 *     Finding 8: a healthy->degraded downgrade used to leave the client
 *     advertising tools that now return in-process-fallback or error bodies
 *     instead of quietly disappearing).
 *   - Any OTHER change of mode kind (degraded->healthy, degraded->skew,
 *     healthy->version-mismatch, version-mismatch->healthy, etc.) notifies
 *     too — not only the "leaving degraded" case (fix round 3 / Finding 6:
 *     a healthy daemon downgrading straight to version-mismatch or
 *     major-skew, without passing through "degraded" first, used to be
 *     silent). `_previousModeKind` reassigned unconditionally at the top is
 *     what makes a repeat resolution of the SAME kind a no-op here, so this
 *     can't double-notify on its own.
 *   - Fix round (MINOR 5): a re-resolution that lands "healthy" -> "healthy"
 *     (the daemon died and came back, or was upgraded, between two calls,
 *     without this session ever observably passing through a different
 *     kind) is invisible to the kind-change check above. Compare
 *     served-tool signatures directly for this one case so a manifest
 *     change is still caught when the mode KIND never changed.
 *
 * `sendToolListChanged()` itself is best-effort throughout: per the D4 probe
 * finding, the call cannot tell us whether the client is listening (it
 * resolves either way), so nothing here can distinguish "notified" from
 * "declared capability ignored" — that is exactly why the capability
 * declaration itself, not this call, is what the tests must assert.
 */
function onModeResolved(mode: ShimMode): void {
  const previousKind = _previousModeKind;
  const kindChanged = previousKind !== null && previousKind !== mode.kind;
  const wasHealthy = previousKind === "healthy";
  // Every mode except "healthy" is a NON-SERVING one: the daemon's real tool
  // surface is not being served, and the way out of all three is the same —
  // the daemon starts, or restarts on a version the shim can talk to. They
  // therefore share one epoch, one deadline and one poller.
  const wasNonServing = previousKind !== null && previousKind !== "healthy";

  _previousModeKind = mode.kind;

  if (mode.kind !== "healthy") {
    if (!wasNonServing) {
      // Fix round (MINOR 4) — the deadline is owned by the EPOCH, set once
      // here on a genuinely fresh entry, and read-only everywhere else
      // (including inside startReadinessPollerIfNeeded). See that
      // function's doc comment for the race this closes.
      _readinessPollDeadline = Date.now() + LIST_CHANGED_POLL_CEILING_MS;
    }
    // Finding 8 — a fresh entry into a non-serving mode FROM a serving one
    // (not from process start, where there is nothing stale to correct) is
    // itself a served-tool-list change and must notify. So is a move BETWEEN
    // two non-serving kinds (e.g. major-skew -> degraded), which changes the
    // served list from the 1-tool placeholder to the offline trio.
    if (kindChanged && _server) {
      _server.sendToolListChanged().catch(() => { /* best-effort, see above */ });
    }
    startReadinessPollerIfNeeded();
    return;
  }

  stopReadinessPoller();
  // Fix round 2 (MAJOR) — the deadline is scoped to the NON-SERVING EPOCH,
  // not to the process. Going healthy closes the epoch, so a deadline left
  // over from it must not go on reading as "still armed" to a LATER,
  // unrelated re-entry into "unavailable" — e.g. the D8 invalidation site
  // below, reached long after this transition, from a totally different
  // failure. Without this reset, that site's `_readinessPollDeadline === 0`
  // check saw a not-yet-naturally-expired (but stale) value, skipped
  // resetting it, and handed a freshly armed poller only whatever sliver of
  // the OLD epoch's window happened to remain — sometimes less than one
  // poll interval, so its very first tick found itself already past due and
  // stopped without ever calling getShimMode(). See that site's own comment
  // for the full sequence this closes.
  _readinessPollDeadline = 0;

  // Finding 6 — any change of KIND (not only a departure from "degraded")
  // changes what is served, so any change of kind notifies. Skipped on the
  // very first-ever resolution (`previousKind === null`): that resolution
  // IS the client's first tools/list answer, already accurate, nothing to
  // correct.
  if (kindChanged && _server) {
    _server.sendToolListChanged().catch(() => { /* best-effort, see above */ });
    _lastHealthyToolSignature = toolSignature(mode.filteredTools);
    return;
  }

  // MINOR 5 — see the doc comment above: catches a healthy->healthy manifest
  // change that the kind-change check above cannot see because the mode
  // kind never left "healthy".
  const sig = toolSignature(mode.filteredTools);
  if (wasHealthy && _lastHealthyToolSignature !== null && sig !== _lastHealthyToolSignature && _server) {
    _server.sendToolListChanged().catch(() => { /* best-effort, see above */ });
  }
  _lastHealthyToolSignature = sig;
}

async function getShimMode(): Promise<ShimMode> {
  if (_cachedMode && _cachedMode.kind === "healthy") {
    return _cachedMode;
  }
  if (_resolving) return _resolving;

  _resolving = resolveShimMode()
    .then((mode) => {
      _cachedMode = mode;
      onModeResolved(mode);
      return mode;
    })
    .finally(() => {
      _resolving = null;
    });

  return _resolving;
}

export async function runMcpShim(): Promise<void> {
  // Plan 121 D3/D11 — exactly one Server for the whole process lifetime, one
  // fixed name regardless of mode. The pre-refactor code built a differently
  // named Server per branch ("scrybe (daemon unavailable)" for the degraded
  // path, "scrybe (daemon out of date)" for major skew, "scrybe" for the
  // healthy path); those two extra strings are dropped deliberately per D11
  // — serverInfo.name is fixed at construction and cannot change after
  // connect, so a single connectable instance cannot carry three names. The
  // state that used to live in the name is now conveyed only through the
  // tool list and its descriptions.
  //
  // Plan 121 slice 3 — no daemon resolution happens here anymore. The old
  // `const mode = await resolveShimMode();` that used to sit in this
  // function, ahead of `server.connect()`, is gone: `initialize` now
  // answers immediately regardless of what the daemon is doing, and
  // resolution happens lazily inside the handlers via getShimMode() below.
  //
  // Plan 121 slice 5 (D4/D9) — `listChanged: true` is declared here, and it
  // is load-bearing, not decorative: measured against the real MCP SDK
  // Client, `server.sendToolListChanged()` resolves without throwing and the
  // client silently never re-lists when this capability is left undeclared
  // (`{ tools: {} }`, as this construction had until now) — measured against
  // the real client, not inferred from the spec. A test
  // that only asserts "the notification was sent" cannot tell the declared
  // case apart from this one; the declared capability itself is the thing
  // under test.
  const server = new Server(
    { name: "scrybe", version: VERSION },
    { capabilities: { tools: { listChanged: true } } }
  );
  // Stashed for onModeResolved() (D9) to call sendToolListChanged() on. One
  // Server per process (D3/D11), so a single module-level binding is enough.
  _server = server;

  server.setRequestHandler(ListToolsRequestSchema, async () => {
    const mode = await getShimMode();
    switch (mode.kind) {
      case "degraded":
        return {
          tools: mode.tools.map((t) => ({
            name: t.name,
            description: t.description,
            inputSchema: t.inputSchema as { type: string; properties?: Record<string, unknown> },
          })),
        };

      // Fix round (MAJOR 1) — version-mismatch serves the same 3-tool
      // degraded set as "degraded" (parity with HEAD's serveUnavailableServer,
      // which built it unconditionally for every unavailable variant).
      // major-skew keeps its own single scrybe_daemon_unavailable tool — that
      // matches HEAD too, where the skew path built its own one-tool server.
      case "version-mismatch":
        return {
          tools: mode.tools.map((t) => ({
            name: t.name,
            description: t.description,
            inputSchema: t.inputSchema as { type: string; properties?: Record<string, unknown> },
          })),
        };

      case "major-skew":
        return {
          tools: [
            {
              name: "scrybe_daemon_unavailable",
              description: mode.description,
              inputSchema: { type: "object", properties: {}, required: [] },
            },
          ],
        };

      case "healthy":
        return {
          tools: mode.filteredTools.map((t) => ({
            name: t.name,
            description: t.description,
            inputSchema: t.inputSchema as { type: string; properties?: Record<string, unknown> },
            ...(t.annotations ? { annotations: t.annotations } : {}),
          })),
        };
    }
  });

  server.setRequestHandler(CallToolRequestSchema, async (request) => {
    const { name, arguments: args } = request.params;
    const params = (args ?? {}) as Record<string, unknown>;

    // D9/D10 — a CallTool can arrive before any ListTools call has resolved
    // a mode (nothing enforces the client calls tools/list first, even
    // though this repo's own client always does). getShimMode() is the same
    // lazy/cached/coalesced resolver ListTools uses, so this is a shared
    // resolution, not a second one — reaching here first just means THIS
    // call pays for it instead of a preceding ListTools call.
    const mode = await getShimMode();

    switch (mode.kind) {
      case "degraded": {
        if (name === "status" || name === "doctor" || name === "init") {
          return await runDegradedToolByName(name, params, mode.configPresent);
        }

        // Fallback for any unexpected tool name
        return jsonResult({
          error: mode.unavailable.description,
        });
      }

      // Fix round (MAJOR 1) — version-mismatch resolves status/doctor/init
      // in-process, same as "degraded"; any other name falls back to the
      // explanatory description, exactly as HEAD's serveUnavailableServer()
      // did for its unexpected-name fallback.
      case "version-mismatch": {
        if (name === "status" || name === "doctor" || name === "init") {
          return await runDegradedToolByName(name, params, mode.configPresent);
        }
        return jsonResult({
          error: mode.description,
        });
      }

      case "major-skew":
        return jsonResult({
          error: mode.description,
        });

      case "healthy": {
        // D4/D10: check current skew state (may have been refreshed by callRpc
        // after re-resolve). `_currentSkew` is set inside resolveShimMode()
        // before it ever returns a "healthy" mode, so in practice this is
        // never null here — but it is no longer asserted as such (D10): the
        // ordering that used to guarantee it (one resolution, at startup,
        // strictly before any handler ran) is gone now that CallTool can be
        // the very first handler invoked. Fail closed instead of throwing.
        const skew = _currentSkew;
        if (!skew) {
          return jsonResult({
            error: "scrybe daemon state not yet resolved — retry the call",
          });
        }

        if (!skew.allowedTools.has(name)) {
          return jsonResult({
            error: `method not found, restart daemon to expose tool ${name}`,
          });
        }

        // D4: if re-resolve landed on a major-skewed or pre-upgrade-boundary daemon, surface per-call error
        if (skew.isMajorSkew) {
          return jsonResult({
            error: `daemon version mismatch after port change — restart to update: scrybe daemon restart`,
          });
        }

        if (skew.isPreUpgradeBoundary) {
          return jsonResult({
            error:
              `Run: scrybe daemon restart --force   (then reconnect)\n` +
              `\n` +
              `scrybe v0.34.0 upgraded lancedb. The running daemon is still on the old version\n` +
              `and cannot use the new on-disk format helpers. Stop + start refreshes the daemon\n` +
              `with the new lancedb binary. Existing data is preserved (lancedb 0.27 reads\n` +
              `0.14-written tables transparently).\n` +
              `\n` +
              `If the stop command fails with EPERM on Windows, close all Claude Code / IDE\n` +
              `sessions first — they hold the lancedb native binding open.`,
          });
        }

        try {
          const result = await callRpc(name, params);
          return jsonResult(result);
        } catch (err) {
          // Plan 121 D8 — the daemon that made this session "healthy" can
          // die mid-session. getShimMode() caches a "healthy" mode until
          // something invalidates it (see getShimMode above), so without
          // this every subsequent call would keep forwarding to a dead
          // daemon indefinitely. Only a
          // connect-class/draining failure means "the daemon is actually
          // unreachable" (callRpc already retried and, if configured,
          // attempted an auto-spawn before this rethrows — see callRpc
          // above); anything else is a real RPC-level error from a live
          // daemon and must not trigger this.
          if (isConnectClassError(err) || isDrainingError(err)) {
            // Invalidate the cache so the NEXT getShimMode() call
            // re-resolves for real. detectDaemonUnavailable() inside
            // resolveShimMode() does one live health check; `_ensureAttempted`
            // is latched unconditionally on resolveShimMode()'s very first
            // call — including a warm one that never entered the spawn
            // branch (fix round, MAJOR 2) — so a re-resolution triggered by
            // THIS invalidation can never re-trigger resolveShimMode()'s OWN
            // auto-spawn attempt.
            //
            // Fix round 2 (MINOR 5, comment correction) — that is narrower
            // than "no respawning a daemon the user deliberately stopped",
            // which this comment used to claim outright. `callRpc` has its
            // own, independent auto-spawn attempt on its connect-class path
            // (`ensureRunning(5000)`, above this catch, before the rethrow
            // that lands us here) — it does not consult `_ensureAttempted`
            // at all, so a daemon the user just stopped can still be
            // respawned by THAT call, on the very RPC that reaches this
            // block. `_ensureAttempted` only ever closed the
            // `resolveShimMode()` half of that gap (Fix round, MAJOR 2);
            // `callRpc`'s own spawn attempt predates this plan and changing
            // it is out of scope here — left open as a follow-up.
            _cachedMode = null;

            // Fix round (MINOR 6) — arm the readiness poller here too, not
            // only from a resolution that has already completed as
            // "degraded" (see onModeResolved below). Without this, a client
            // that makes exactly this one call and then goes idle forever
            // never gets a second chance to notice the daemon recovering —
            // nothing else would call getShimMode() again. The poller's own
            // next tick re-resolves for real and lets onModeResolved take
            // over the epoch's bookkeeping (deadline, notification) through
            // its normal fresh-entry path; this just has to make sure a
            // poller — and a deadline for this epoch — already exists in the
            // meantime.
            //
            // Fix round 2 (MAJOR) — the `_readinessPollDeadline === 0` half
            // of this check is what makes that safe. It used to be claimed
            // here that Minor 4 "keeps a deadline outside its handle's
            // lifetime" and that this preserved that invariant — false:
            // Minor 4 only ever made `startReadinessPollerIfNeeded` READ the
            // deadline instead of re-deriving it; nothing cleared it when a
            // degraded epoch ENDED, so a call landing here after the session
            // had already gone healthy could still see the previous epoch's
            // deadline, unexpired but stale, and skip resetting it — arming
            // a poller against a window that had nothing to do with the
            // failure happening right now. `onModeResolved`'s "leaving
            // degraded" branch now zeroes `_readinessPollDeadline` the
            // moment a degraded epoch ends, so by the time this invalidation
            // runs — always downstream of an earlier healthy resolution —
            // it reliably reads 0 here, and this branch grants a full, fresh
            // window scoped to the epoch THIS failure is actually starting.
            if (_readinessPollDeadline === 0 || Date.now() >= _readinessPollDeadline) {
              _readinessPollDeadline = Date.now() + LIST_CHANGED_POLL_CEILING_MS;
            }
            startReadinessPollerIfNeeded();

            // THIS call still needs an answer now. status/doctor/init are
            // the D8 collision — the only names with an in-process fallback
            // to serve instead of a raw connection error for a tool the
            // client believes is real. Anything else has no such fallback
            // and falls through to the ordinary error result below.
            if (name === "status" || name === "doctor" || name === "init") {
              return await runDegradedToolByName(name, params);
            }
          }
          return callToolErrorResult(err);
        }
      }
    }
  });

  const transport = new StdioServerTransport();
  // Plan 121 slice 2 — the pre-refactor degraded path called
  // `server.connect(transport)` here WITHOUT awaiting, while the skew and
  // healthy paths both awaited it. Unified to awaited: there is now only one
  // call site, so the inconsistency has nowhere left to hide.
  await server.connect(transport);

  _startHeartbeatLoop();
}

// ─── Testing seams (exported for unit tests, not part of public API) ──────────

/** @internal */
export const __testing = {
  /** Read the current module-level base URL. */
  getBaseUrl: () => _baseUrl,
  /** Overwrite the module-level base URL (allows tests to inject a port). */
  setBaseUrl: (url: string) => { _baseUrl = url; },
  /** Check whether an error is a connect-class error (D3 classifier). */
  isConnectClassError,
  /** Invoke callRpc directly with injected state. */
  callRpc,
  /** Build the CallTool error response for a caught callRpc failure (Plan 94 Decision 4). */
  callToolErrorResult,
  /** Trigger a heartbeat tick (for heartbeat-update tests). */
  sendHeartbeat: _sendHeartbeat,
  /** Get current skew state. */
  getSkew: () => _currentSkew,
  /** Set skew state (for test injection). */
  setSkew: (s: VersionSkewState | null) => { _currentSkew = s; },
  /** Read the module-load-time-computed in-handler wait budget (Plan 121 D1). */
  getColdStartWaitMs: () => COLD_START_WAIT_MS,
  /** Read the module-load-time-computed readiness-poll interval (Plan 121 D9). */
  getListChangedPollIntervalMs: () => LIST_CHANGED_POLL_INTERVAL_MS,
  /** Read the module-load-time-computed readiness-poll ceiling (Plan 121 D9). */
  getListChangedPollCeilingMs: () => LIST_CHANGED_POLL_CEILING_MS,
  /** Whether the D9 background readiness poller is currently armed. */
  hasActiveReadinessPoller: () => _readinessPollHandle !== null,
  /**
   * Fix round (MAJOR 2 test seam) — resolve the shim mode through the same
   * lazy/cached/coalesced path the ListTools/CallTool handlers use, without
   * running a whole server. Lets a unit test drive resolveShimMode()
   * (including the `_ensureAttempted` latch) directly.
   */
  getShimMode,
  /**
   * Fix round (MAJOR 2 / MINOR 6 test seam) — mirrors the CallTool healthy
   * branch's D8 invalidation (`_cachedMode = null`) so a test can simulate
   * "the daemon the client believed was healthy just stopped answering"
   * without a real connect-class RPC failure.
   */
  invalidateCachedMode: () => { _cachedMode = null; },
};
