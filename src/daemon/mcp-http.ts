// Stateless Streamable HTTP MCP transport at /mcp, off unless SCRYBE_DAEMON_MCP_HTTP is 1 or true (#102).
import http from "node:http";
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
} from "@modelcontextprotocol/sdk/types.js";
import { VERSION } from "../config.js";
import { buildManifest, dispatchMcpTool, getClientId, maskInternalErrorMessage } from "./mcp-rpc.js";

function methodNotAllowed(res: http.ServerResponse): void {
  const data = JSON.stringify({
    jsonrpc: "2.0",
    error: { code: -32000, message: "Method not allowed." },
    id: null,
  });
  res.writeHead(405, { "Content-Type": "application/json", "Content-Length": Buffer.byteLength(data) });
  res.end(data);
}

function notFound(res: http.ServerResponse): void {
  const data = JSON.stringify({ error: "Not found" });
  res.writeHead(404, { "Content-Type": "application/json", "Content-Length": Buffer.byteLength(data) });
  res.end(data);
}

// HTTP callers have no local pid; register the daemon's own as a stand-in.
const STANDIN_CLIENT_ID = "mcp-http";
const STANDIN_PID = process.pid;

/** SCRYBE_DAEMON_MCP_HTTP is on for "1" or "true" (case-insensitive, trimmed); anything else is off (#102). */
export function isMcpHttpEnabled(): boolean {
  const raw = (process.env["SCRYBE_DAEMON_MCP_HTTP"] ?? "").trim().toLowerCase();
  return raw === "1" || raw === "true";
}

let _onActivity: (() => void) | undefined;

/** Wires the stand-in client's heartbeat into the daemon's lifecycle hook (#102); called once by http-server.ts. */
export function setMcpHttpHeartbeat(onHeartbeat: (clientId: string, pid: number) => void): void {
  _onActivity = () => onHeartbeat(STANDIN_CLIENT_ID, STANDIN_PID);
}

interface McpTextContent {
  type: "text";
  text: string;
}

/** Mirrors src/mcp-shim.ts's jsonResult() — one text block of pretty-printed JSON. */
function jsonResult(data: unknown): { content: McpTextContent[] } {
  return { content: [{ type: "text", text: JSON.stringify(data, null, 2) }] };
}

/** Plain results map like the shim; job results return `{job_id, status: "started"}` at once, like mcp-server.ts. */
export async function toCallToolResult(
  outcome: Awaited<ReturnType<typeof dispatchMcpTool>>
): Promise<{ content: McpTextContent[]; isError?: true }> {
  if (!outcome.ok) {
    return { ...jsonResult({ error: outcome.error.message }), isError: true };
  }

  const result = outcome.result;
  if (result && typeof result === "object" && "jobId" in (result as object)) {
    const jr = result as { jobId: string };
    return jsonResult({ job_id: jr.jobId, status: "started" });
  }

  try {
    return jsonResult(result);
  } catch (err) {
    // Masked the same way as /mcp/rpc's internal-error path (#102).
    const message = err instanceof Error ? err.message : String(err);
    return { ...jsonResult({ error: maskInternalErrorMessage(message) }), isError: true };
  }
}

function buildServer(clientId: string): Server {
  const server = new Server({ name: "scrybe", version: VERSION }, { capabilities: { tools: {} } });

  server.setRequestHandler(ListToolsRequestSchema, async () => ({ tools: buildManifest().tools }));

  server.setRequestHandler(CallToolRequestSchema, async (request) => {
    const { name, arguments: args } = request.params;
    const params = (args ?? {}) as Record<string, unknown>;
    const outcome = await dispatchMcpTool(name, params, clientId);
    return await toCallToolResult(outcome);
  });

  return server;
}

/** Returns true when the request was for /mcp and has been answered. */
export async function handleMcpHttpRoute(
  req: http.IncomingMessage,
  res: http.ServerResponse
): Promise<boolean> {
  const rawPath = new URL(req.url ?? "/", "http://localhost").pathname;
  if (rawPath !== "/mcp") return false;

  if (!isMcpHttpEnabled()) {
    notFound(res);
    return true;
  }

  const method = req.method?.toUpperCase() ?? "GET";
  if (method === "GET" || method === "DELETE") {
    methodNotAllowed(res);
    return true;
  }

  // Only a request that actually reaches the MCP handler keeps the daemon alive.
  _onActivity?.();

  const clientId = getClientId(req);
  const server = buildServer(clientId);
  const transport = new StreamableHTTPServerTransport({
    sessionIdGenerator: undefined,
    enableJsonResponse: true,
  });

  res.on("close", () => {
    transport.close().catch(() => {});
    server.close().catch(() => {});
  });

  await server.connect(transport);
  await transport.handleRequest(req, res);
  return true;
}
