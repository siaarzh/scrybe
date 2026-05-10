/**
 * Daemon-side MCP-over-HTTP endpoints.
 *
 * GET  /mcp/manifest  → {daemon_version, tools: [{name, description, inputSchema}]}
 * POST /mcp/rpc       → {id, method, params} → {id, result} | {id, error: {code, message}}
 *
 * Client identity is read from the X-Scrybe-Client-Id request header and
 * recorded in the log. The header is optional; missing = "anon".
 *
 * Tool handlers are NOT reimplemented here — this module is a pure dispatch
 * layer over the existing mcpTools registry.
 */
import http from "node:http";
import { VERSION } from "../config.js";
import { mcpTools } from "../tools/all-tools.js";

// ─── Types ─────────────────────────────────────────────────────────────────

export interface McpManifest {
  daemon_version: string;
  tools: Array<{
    name: string;
    description: string;
    inputSchema: unknown;
    annotations?: unknown;
  }>;
}

export interface RpcRequest {
  id: unknown;
  method: string;
  params: Record<string, unknown>;
}

export interface RpcSuccess {
  id: unknown;
  result: unknown;
}

export interface RpcError {
  id: unknown;
  error: { code: number; message: string };
}

// ─── JSON-RPC error codes ──────────────────────────────────────────────────

const INVALID_REQUEST = -32600;
const METHOD_NOT_FOUND = -32601;
const INTERNAL_ERROR = -32603;

// ─── Helpers ───────────────────────────────────────────────────────────────

function jsonRes(res: http.ServerResponse, status: number, body: unknown): void {
  const data = JSON.stringify(body);
  res.writeHead(status, {
    "Content-Type": "application/json",
    "Content-Length": Buffer.byteLength(data),
  });
  res.end(data);
}

async function readBody(req: http.IncomingMessage): Promise<unknown> {
  const chunks: Buffer[] = [];
  for await (const chunk of req) chunks.push(chunk as Buffer);
  const raw = Buffer.concat(chunks).toString("utf8");
  if (!raw.trim()) return {};
  return JSON.parse(raw);
}

function getClientId(req: http.IncomingMessage): string {
  const header = req.headers["x-scrybe-client-id"];
  if (typeof header === "string" && header.trim()) return header.trim();
  return "anon";
}

// ─── Manifest (cached once per process — tool list is static) ─────────────

let _manifest: McpManifest | null = null;

export function buildManifest(): McpManifest {
  if (_manifest) return _manifest;
  _manifest = {
    daemon_version: VERSION,
    tools: mcpTools.map((t) => ({
      name: t.spec.name,
      description: t.spec.description,
      inputSchema: t.spec.inputSchema,
      ...(t.spec.annotations ? { annotations: t.spec.annotations } : {}),
    })),
  };
  return _manifest;
}

// ─── Route handlers ────────────────────────────────────────────────────────

async function handleManifest(
  _req: http.IncomingMessage,
  res: http.ServerResponse
): Promise<void> {
  jsonRes(res, 200, buildManifest());
}

async function handleRpc(
  req: http.IncomingMessage,
  res: http.ServerResponse
): Promise<void> {
  const clientId = getClientId(req);

  let body: unknown;
  try {
    body = await readBody(req);
  } catch {
    jsonRes(res, 200, {
      id: null,
      error: { code: INVALID_REQUEST, message: "invalid request: body is not valid JSON" },
    } satisfies RpcError);
    return;
  }

  const raw = body as Record<string, unknown>;

  if (
    typeof raw["id"] === "undefined" ||
    typeof raw["method"] !== "string" ||
    !raw["method"]
  ) {
    jsonRes(res, 200, {
      id: raw["id"] ?? null,
      error: { code: INVALID_REQUEST, message: "invalid request: missing id or method" },
    } satisfies RpcError);
    return;
  }

  const id = raw["id"];
  const method = raw["method"] as string;
  const params = (typeof raw["params"] === "object" && raw["params"] !== null && !Array.isArray(raw["params"]))
    ? (raw["params"] as Record<string, unknown>)
    : {};

  const tool = mcpTools.find((t) => t.spec.name === method);

  if (!tool) {
    console.log(`[mcp-rpc] client=${clientId} method=${method} → method not found`);
    jsonRes(res, 200, {
      id,
      error: { code: METHOD_NOT_FOUND, message: `method not found: ${method}` },
    } satisfies RpcError);
    return;
  }

  console.log(`[mcp-rpc] client=${clientId} method=${method}`);

  try {
    const result = await tool.handler(params);
    jsonRes(res, 200, { id, result } satisfies RpcSuccess);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    console.log(`[mcp-rpc] client=${clientId} method=${method} → error: ${message}`);
    jsonRes(res, 200, {
      id,
      error: { code: INTERNAL_ERROR, message },
    } satisfies RpcError);
  }
}

// ─── Route registration ────────────────────────────────────────────────────

/**
 * Registers GET /mcp/manifest and POST /mcp/rpc on the daemon HTTP server.
 *
 * Call this inside the http.createServer request handler by checking the
 * path prefix and delegating. Returns true when the route was handled,
 * false otherwise (caller should continue to its own routing).
 */
export async function handleMcpRoute(
  req: http.IncomingMessage,
  res: http.ServerResponse
): Promise<boolean> {
  const method = req.method?.toUpperCase() ?? "GET";
  const rawPath = new URL(req.url ?? "/", "http://localhost").pathname;

  if (rawPath === "/mcp/manifest" && method === "GET") {
    await handleManifest(req, res);
    return true;
  }

  if (rawPath === "/mcp/rpc" && method === "POST") {
    await handleRpc(req, res);
    return true;
  }

  return false;
}
