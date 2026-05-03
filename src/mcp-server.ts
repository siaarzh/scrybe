import { hostname } from "os";
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
} from "@modelcontextprotocol/sdk/types.js";
import { VERSION } from "./config.js";
import { checkAndMigrate } from "./schema-version.js";
import { mcpTools } from "./tools/all-tools.js";

// ─── MCP tool list ────────────────────────────────────────────────────────────

const TOOLS = mcpTools.map((t) => ({
  name: t.spec.name,
  description: t.spec.description,
  inputSchema: t.spec.inputSchema,
  ...(t.spec.annotations && { annotations: t.spec.annotations }),
}));

// ─── Error classifier ─────────────────────────────────────────────────────────

function classifyError(err: unknown): { error: string; error_type?: string; details?: unknown } {
  const status = (err as { status?: number })?.status;
  const message = err instanceof Error ? err.message : String(err);

  // Structured table_corrupt error from search tools — preserve details for agent consumption
  const errType = (err as { error_type?: string })?.error_type;
  if (errType === "table_corrupt") {
    return {
      error: message,
      error_type: "table_corrupt",
      details: (err as { details?: unknown })?.details,
    };
  }

  if (status === 429 || /429/.test(message)) {
    return {
      error:
        "Embedding API rate limit exceeded. The reindex or search cannot proceed right now. " +
        "Wait a minute and retry, or check your embedding provider's rate limit tier " +
        "(e.g. Voyage AI requires a payment method on file to unlock standard limits).",
      error_type: "rate_limit",
    };
  }
  if (status === 401 || /401|unauthorized|api.?key/i.test(message)) {
    return {
      error: "Embedding API authentication failed. Check that SCRYBE_CODE_EMBEDDING_API_KEY is set correctly.",
      error_type: "auth",
    };
  }
  if (/SCRYBE_CODE_EMBEDDING_DIMENSIONS=\d+/.test(message)) return { error: message, error_type: "dimensions_mismatch" };
  if (message.startsWith("NO_CODE_SOURCES")) return { error: message.replace(/^NO_CODE_SOURCES:\s*/, ""), error_type: "no_code_sources" };
  if (message.startsWith("NO_KNOWLEDGE_SOURCES")) return { error: message.replace(/^NO_KNOWLEDGE_SOURCES:\s*/, ""), error_type: "no_knowledge_sources" };
  if (/Unknown embedding provider|SCRYBE_CODE_EMBEDDING_MODEL is not set/.test(message)) return { error: message, error_type: "unknown_provider" };
  if (/ENOENT|EACCES|EPERM|EISDIR|ENOTDIR/.test(message)) return { error: message, error_type: "file_system" };
  if (/corrupt|malformed|unexpected token|invalid.*manifest/i.test(message)) return { error: message, error_type: "data_corruption" };
  return { error: message, error_type: "internal" };
}

function textResult(text: string) {
  return { content: [{ type: "text" as const, text }] };
}

function jsonResult(data: unknown) {
  return textResult(JSON.stringify(data, null, 2));
}

// ─── Server ───────────────────────────────────────────────────────────────────

export async function runMcpServer(): Promise<void> {
  await checkAndMigrate();
  const server = new Server(
    { name: "scrybe", version: VERSION },
    { capabilities: { tools: {} } }
  );

  server.setRequestHandler(ListToolsRequestSchema, async () => ({ tools: TOOLS }));

  server.setRequestHandler(CallToolRequestSchema, async (request) => {
    const { name, arguments: args } = request.params;
    const a = (args ?? {}) as Record<string, unknown>;

    const tool = mcpTools.find((t) => t.spec.name === name);
    if (!tool) return jsonResult({ error: `Unknown tool: ${name}` });

    try {
      const result = await tool.handler(a as any);

      // Job-aware: MCP returns job_id immediately, CLI awaits completion
      if (result && typeof result === "object" && "jobId" in (result as object)) {
        const jr = result as { jobId: string; awaitable: Promise<unknown> };
        return jsonResult({ job_id: jr.jobId, status: "started" });
      }

      return jsonResult(result);
    } catch (err) {
      return jsonResult(classifyError(err));
    }
  });

  const transport = new StdioServerTransport();
  await server.connect(transport);

  // Daemon bootstrap (probe + spawn) can take ~2s when execPath mismatches —
  // e.g. when MCP is spawned by VS Code's bundled Node. Run it in the
  // background so the MCP handshake isn't blocked behind it.
  bootstrapDaemon().catch(() => {});
}

// ─── On-demand daemon lifecycle (M-D11.1) ────────────────────────────────────

const _clientId = `${hostname()}:${process.pid}:${Date.now()}`;
const HEARTBEAT_MS = parseInt(process.env["SCRYBE_DAEMON_HEARTBEAT_MS"] ?? "30000", 10);
let _heartbeatInterval: ReturnType<typeof setInterval> | null = null;
let _unregisterCalled = false;

async function bootstrapDaemon(): Promise<void> {
  if (process.env["SCRYBE_NO_AUTO_DAEMON"] === "1") return;

  const { isContainer } = await import("./daemon/container-detect.js");
  if (isContainer()) return;

  const { isDaemonRunning } = await import("./daemon/pidfile.js");
  const { running } = await isDaemonRunning();
  if (!running) {
    const { spawnDaemonDetached } = await import("./daemon/spawn-detached.js");
    spawnDaemonDetached({});
  }

  _startHeartbeatLoop();
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

async function _sendHeartbeat(): Promise<void> {
  const { readPidfile } = await import("./daemon/pidfile.js");
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

async function _unregisterAndExit(): Promise<void> {
  if (_unregisterCalled) return;
  _unregisterCalled = true;

  if (_heartbeatInterval) { clearInterval(_heartbeatInterval); _heartbeatInterval = null; }

  try {
    const { readPidfile } = await import("./daemon/pidfile.js");
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
