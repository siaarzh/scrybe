import { hostname } from "node:os";
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
} from "@modelcontextprotocol/sdk/types.js";
import { VERSION } from "./config.js";
import { DaemonClient } from "./daemon/client.js";
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

function serveUnavailableServer(unavailable: DaemonUnavailableState): void {
  const server = new Server(
    { name: "scrybe (daemon unavailable)", version: VERSION },
    { capabilities: { tools: {} } }
  );

  server.setRequestHandler(ListToolsRequestSchema, async () => ({
    tools: [
      {
        name: "scrybe_daemon_unavailable",
        description: unavailable.description,
        inputSchema: { type: "object", properties: {}, required: [] },
      },
    ],
  }));

  server.setRequestHandler(CallToolRequestSchema, async () => {
    return jsonResult({
      error: unavailable.description,
    });
  });

  const transport = new StdioServerTransport();
  server.connect(transport);
  _startHeartbeatLoop();
}

// ─── Main shim entrypoint ─────────────────────────────────────────────────────

export async function runMcpShim(): Promise<void> {
  const unavailable = await detectDaemonUnavailable();
  if (unavailable) {
    serveUnavailableServer(unavailable);
    return;
  }

  const pidData = readPidfile();
  const port = pidData!.port;
  const baseUrl = `http://127.0.0.1:${port}`;

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
