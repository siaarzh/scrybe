import { hostname } from "node:os";
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
} from "@modelcontextprotocol/sdk/types.js";
import { VERSION, readScrybeConfig } from "./config.js";
import { DaemonClient, ensureRunning } from "./daemon/client.js";
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

// ─── Heartbeat (mirrors mcp-server.ts pattern) ────────────────────────────────

const _clientId = `${hostname()}:${process.pid}:${Date.now()}`;
const HEARTBEAT_MS = parseInt(process.env["SCRYBE_DAEMON_HEARTBEAT_MS"] ?? "30000", 10);
let _heartbeatInterval: ReturnType<typeof setInterval> | null = null;
let _unregisterCalled = false;

async function _sendHeartbeat(): Promise<void> {
  const pidData = readPidfile();
  if (!pidData?.port) return;
  try {
    // lgtm[js/file-access-to-http] -- loopback only; port from pidfile owned by current user
    await fetch(`http://127.0.0.1:${pidData.port}/clients/heartbeat`, {
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

async function callRpc(
  baseUrl: string,
  method: string,
  params: Record<string, unknown>
): Promise<unknown> {
  const id = Math.random().toString(36).slice(2);
  // lgtm[js/file-access-to-http] -- loopback only; port from pidfile owned by current user
  const res = await fetch(`${baseUrl}/mcp/rpc`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "X-Scrybe-Client-Id": _clientId,
    },
    body: JSON.stringify({ id, method, params }),
    signal: AbortSignal.timeout(30000),
  });

  if (!res.ok) {
    throw new Error(`daemon RPC returned HTTP ${res.status}`);
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

// ─── Version skew helpers ────────────────────────────────────────────────────

interface VersionSkewState {
  isMajorSkew: boolean;
  isMinorOrPatchSkew: boolean;
  allowedTools: Set<string>;
}

function analyzeVersionSkew(daemonVersion: string, shimVersion: string): VersionSkewState {
  const cmp = compareSemVer(daemonVersion, shimVersion);
  if (cmp === null) {
    return { isMajorSkew: false, isMinorOrPatchSkew: false, allowedTools: new Set(KNOWN_TOOL_NAMES) };
  }

  const daemonMajor = getMajorVersion(daemonVersion);
  const shimMajor = getMajorVersion(shimVersion);

  const isMajorSkew = daemonMajor !== null && shimMajor !== null && daemonMajor !== shimMajor;
  const isMinorOrPatchSkew = !isMajorSkew && cmp !== 0;

  return {
    isMajorSkew,
    isMinorOrPatchSkew,
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
  const { config, VERSION: ver, readScrybeConfig } = await import("./config.js");
  const configObj = readScrybeConfig();
  return {
    version: ver,
    config_present: configObj !== null,
    daemon_running: false,
    daemon_pid: null,
    daemon_port: null,
    daemon_version: null,
    code_provider_type: config.embeddingProviderType,
    code_model: config.embeddingModel,
    text_provider_type: config.textEmbeddingProviderType,
    text_model: config.textEmbeddingModel,
    api_key_present: !!config.embeddingApiKey,
    config_error: !!config.embeddingConfigError,
    config_error_message: config.embeddingConfigError ?? null,
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
 */
async function degradedInit(configPresent: boolean): Promise<unknown> {
  try {
    process.stderr.write("[scrybe-mcp] degraded init: attempting ensureRunning\n");
    const result = await ensureRunning(30_000);
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

// ─── Degraded tool specs (used in serveUnavailableServer) ─────────────────────

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

function serveUnavailableServer(unavailable: DaemonUnavailableState): void {
  // Compute config-present once at server-construction time (synchronous).
  // We need it to differentiate status/init descriptions.
  let configPresent = false;
  try {
    // readScrybeConfig is synchronous; statically imported (ESM — no require()).
    configPresent = readScrybeConfig() !== null;
  } catch { /* best-effort; defaults to false */ }

  const degradedTools = buildDegradedTools(configPresent);

  const server = new Server(
    { name: "scrybe (daemon unavailable)", version: VERSION },
    { capabilities: { tools: {} } }
  );

  server.setRequestHandler(ListToolsRequestSchema, async () => ({
    tools: degradedTools.map((t) => ({
      name: t.name,
      description: t.description,
      inputSchema: t.inputSchema as { type: string; properties?: Record<string, unknown> },
    })),
  }));

  server.setRequestHandler(CallToolRequestSchema, async (request) => {
    const { name, arguments: args } = request.params;
    const params = (args ?? {}) as Record<string, unknown>;

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

    if (name === "init") {
      try {
        return jsonResult(await degradedInit(configPresent));
      } catch (err) {
        return jsonResult({ error: `init failed: ${err instanceof Error ? err.message : String(err)}` });
      }
    }

    // Fallback for any unexpected tool name
    return jsonResult({
      error: unavailable.description,
    });
  });

  const transport = new StdioServerTransport();
  server.connect(transport);
  _startHeartbeatLoop();
}

// ─── Main shim entrypoint ─────────────────────────────────────────────────────

const COLD_START_WAIT_MS = (() => {
  const raw = parseInt(process.env["SCRYBE_MCP_COLD_START_WAIT_MS"] ?? "", 10);
  return Number.isFinite(raw) && raw >= 0 ? raw : 15_000;
})();

export async function runMcpShim(): Promise<void> {
  let unavailable = await detectDaemonUnavailable();
  if (unavailable && COLD_START_WAIT_MS > 0) {
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
    serveUnavailableServer(unavailable);
    return;
  }

  const pidData = readPidfile();
  const port = pidData!.port;
  const baseUrl = `http://127.0.0.1:${port}`;

  // lgtm[js/file-access-to-http] -- loopback only; port from pidfile owned by current user
  const manifestRes = await fetch(`${baseUrl}/mcp/manifest`, {
    signal: AbortSignal.timeout(5000),
  });

  if (!manifestRes.ok) {
    throw new Error(`failed to fetch daemon manifest: HTTP ${manifestRes.status}`);
  }

  const manifest = (await manifestRes.json()) as McpManifest;
  const daemonVersion = manifest.daemon_version || "";

  // ── lancedb upgrade boundary: shim >= 0.34.0, daemon < 0.34.0 ──────────────
  if (isShimPostUpgrade(VERSION) && isDaemonPreUpgrade(daemonVersion)) {
    serveUnavailableServer({
      variant: "daemon-version-mismatch",
      description:
        "Run: scrybe daemon stop && scrybe daemon start   (then reconnect)\n" +
        "\n" +
        "scrybe v0.34.0 upgraded lancedb. The running daemon is still on the old version\n" +
        "and cannot use the new on-disk format helpers. Stop + start refreshes the daemon\n" +
        "with the new lancedb binary. Existing data is preserved (lancedb 0.27 reads\n" +
        "0.14-written tables transparently).\n" +
        "\n" +
        "If the stop command fails with EPERM on Windows, close all Claude Code / IDE\n" +
        "sessions first — they hold the lancedb native binding open.",
    });
    return;
  }

  const skew = analyzeVersionSkew(daemonVersion, VERSION);

  if (skew.isMajorSkew) {
    const server = new Server(
      { name: "scrybe (daemon out of date)", version: VERSION },
      { capabilities: { tools: {} } }
    );

    const daemonRestartDescription = `daemon version ${daemonVersion} is major-incompatible with shim ${VERSION}. Restart to update: scrybe daemon restart`;

    server.setRequestHandler(ListToolsRequestSchema, async () => ({
      tools: [
        {
          name: "scrybe_daemon_unavailable",
          description: daemonRestartDescription,
          inputSchema: { type: "object", properties: {}, required: [] },
        },
      ],
    }));

    server.setRequestHandler(CallToolRequestSchema, async () => {
      return jsonResult({
        error: daemonRestartDescription,
      });
    });

    const transport = new StdioServerTransport();
    await server.connect(transport);
    _startHeartbeatLoop();
    return;
  }

  if (skew.isMinorOrPatchSkew) {
    console.warn(
      `[scrybe] daemon version ${daemonVersion} differs from shim ${VERSION} (minor/patch) — restart daemon to refresh tool surface`
    );
  }

  const server = new Server(
    { name: "scrybe", version: VERSION },
    { capabilities: { tools: {} } }
  );

  const filteredTools = manifest.tools.filter((t) => skew.allowedTools.has(t.name));

  server.setRequestHandler(ListToolsRequestSchema, async () => ({
    tools: filteredTools.map((t) => ({
      name: t.name,
      description: t.description,
      inputSchema: t.inputSchema as { type: string; properties?: Record<string, unknown> },
      ...(t.annotations ? { annotations: t.annotations } : {}),
    })),
  }));

  server.setRequestHandler(CallToolRequestSchema, async (request) => {
    const { name, arguments: args } = request.params;
    const params = (args ?? {}) as Record<string, unknown>;

    if (!skew.allowedTools.has(name)) {
      return jsonResult({
        error: `method not found, restart daemon to expose tool ${name}`,
      });
    }

    try {
      const result = await callRpc(baseUrl, name, params);
      return jsonResult(result);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      return jsonResult({ error: message });
    }
  });

  const transport = new StdioServerTransport();
  await server.connect(transport);

  _startHeartbeatLoop();
}
