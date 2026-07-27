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
import type { JSONSchema } from "../tools/types.js";
import { diagEmit } from "./events.js";
import { sampleNow } from "./mem-sampler.js";
import { isCallerFacing } from "./caller-error.js";

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
const INVALID_PARAMS = -32602;
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

// Strip CR/LF/control chars so client-controlled clientId/method/error strings
// can't forge fake log lines when logs are pasted into issues or shared.
//
// The CR and LF passes are deliberately spelled out as two separate
// single-character global replacements before the catch-all control-char pass.
// Output is identical to the single `[\r\n\x00-\x1f\x7f]` character class it
// replaces, but static analysers (CodeQL js/log-injection) only recognise a
// replacement as a line-break barrier when the pattern is a literal "\r"/"\n" —
// a character class with ranges is not matched by that model, so the sanitizer
// was invisible to it. Keep these two passes first and separate.
function sanitizeForLog(s: string): string {
  return s
    .replace(/\r/g, "?")
    .replace(/\n/g, "?")
    .replace(/[\x00-\x1f\x7f]/g, "?");
}

const EXPOSE_INTERNAL_ERRORS = process.env["NODE_ENV"] === "development";

// ─── Boundary param validation ─────────────────────────────────────────────
//
// Hand-rolled shape validator against a tool's (flat, non-nested) inputSchema
// — no zod, no JSONSchema→zod bridge (Decision 2, Plan 94). Runs *inside* the
// try/span in handleRpc so a rejected call still emits an activity-span.
// Catches the LLM-invented-arg-name failure class (project_ids/limit/symbol
// instead of project_id/top_k/symbol_name) via strict unknown-key rejection —
// a per-handler required-check can't see an *extra* key, only a boundary
// check can. Conditional-required semantics stay in per-handler guards.

interface ParamValidationError {
  message: string;
}

// Best-effort "did you mean" suggestion for an unknown key: prefer a
// prefix relationship (catches project_ids→project_id, symbol→symbol_name),
// else fall back to a small Levenshtein distance for plain typos.
function suggestKey(unknown: string, knownKeys: string[]): string | undefined {
  const prefixMatch = knownKeys.find(
    (k) => k !== unknown && (k.startsWith(unknown) || unknown.startsWith(k))
  );
  if (prefixMatch) return prefixMatch;

  let best: string | undefined;
  let bestDist = Infinity;
  for (const k of knownKeys) {
    const d = levenshtein(unknown, k);
    if (d < bestDist) {
      bestDist = d;
      best = k;
    }
  }
  return bestDist <= 3 ? best : undefined;
}

function levenshtein(a: string, b: string): number {
  const dp: number[][] = Array.from({ length: a.length + 1 }, () => new Array(b.length + 1).fill(0));
  for (let i = 0; i <= a.length; i++) dp[i]![0] = i;
  for (let j = 0; j <= b.length; j++) dp[0]![j] = j;
  for (let i = 1; i <= a.length; i++) {
    for (let j = 1; j <= b.length; j++) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1;
      dp[i]![j] = Math.min(
        dp[i - 1]![j]! + 1,
        dp[i]![j - 1]! + 1,
        dp[i - 1]![j - 1]! + cost
      );
    }
  }
  return dp[a.length]![b.length]!;
}

function jsonTypeOf(value: unknown): string {
  if (Array.isArray(value)) return "array";
  if (value === null) return "null";
  return typeof value; // "string" | "number" | "boolean" | "object" | "undefined"
}

function checkPropertyType(
  toolName: string,
  key: string,
  value: unknown,
  propSchema: NonNullable<JSONSchema["properties"]>[string]
): ParamValidationError | null {
  const expected = propSchema.type;
  if (expected) {
    const actual = jsonTypeOf(value);
    if (actual !== expected) {
      return {
        message: `invalid params for ${toolName}: '${key}' must be of type ${expected}, got ${actual}`,
      };
    }
  }

  if (propSchema.enum && typeof value === "string" && !propSchema.enum.includes(value)) {
    return {
      message: `invalid params for ${toolName}: '${key}' must be one of [${propSchema.enum.join(", ")}], got '${value}'`,
    };
  }

  if (expected === "array" && propSchema.items && Array.isArray(value)) {
    for (const el of value) {
      const elType = jsonTypeOf(el);
      if (elType !== propSchema.items.type) {
        return {
          message: `invalid params for ${toolName}: '${key}' elements must be of type ${propSchema.items.type}, got ${elType}`,
        };
      }
    }
  }

  return null;
}

/**
 * Validates `params` against `schema` (a flat JSONSchema — no oneOf/nesting,
 * per Decision 2). Returns a field-naming error on the first violation found,
 * or null when valid. Checked in this order: unknown keys (most actionable —
 * the invented-arg-name failure class), missing required, basic type/enum/array.
 */
function validateParams(
  toolName: string,
  schema: JSONSchema,
  params: Record<string, unknown>
): ParamValidationError | null {
  const properties = schema.properties ?? {};
  const knownKeys = Object.keys(properties);
  const required = schema.required ?? [];

  for (const key of Object.keys(params)) {
    if (!knownKeys.includes(key)) {
      const suggestion = suggestKey(key, knownKeys);
      const hint = suggestion ? ` (did you mean '${suggestion}'?)` : "";
      return { message: `invalid params for ${toolName}: unknown key '${key}'${hint}` };
    }
  }

  for (const key of required) {
    // A `null` value for a required field counts as absent: it otherwise
    // slips both this check (`key in params` is true) and the type check
    // below (which skips null), reaching the handler unvalidated.
    if (!(key in params) || params[key] === undefined || params[key] === null) {
      return { message: `invalid params for ${toolName}: missing required '${key}'` };
    }
  }

  for (const [key, value] of Object.entries(params)) {
    if (value === undefined || value === null) continue;
    const propSchema = properties[key];
    if (!propSchema) continue;
    const typeError = checkPropertyType(toolName, key, value, propSchema);
    if (typeError) return typeError;
  }

  return null;
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
  const safeClientId = sanitizeForLog(clientId);
  const safeMethod = sanitizeForLog(method);

  if (!tool) {
    console.log(`[mcp-rpc] client=${safeClientId} method=${safeMethod} → method not found`);
    jsonRes(res, 200, {
      id,
      error: { code: METHOD_NOT_FOUND, message: `method not found: ${method}` },
    } satisfies RpcError);
    return;
  }

  console.log(`[mcp-rpc] client=${safeClientId} method=${safeMethod}`);

  // Activity span telemetry — capture start RSS and emit span record on completion.
  const spanStart = Date.now();
  const startSample = sampleNow();
  let spanOutcome: "ok" | "error" = "ok";
  let spanErrorMessage: string | undefined;

  try {
    const validationError = validateParams(method, tool.spec.inputSchema, params);
    if (validationError) {
      spanOutcome = "error";
      spanErrorMessage = sanitizeForLog(validationError.message);
      console.log(`[mcp-rpc] client=${safeClientId} method=${safeMethod} → error: ${spanErrorMessage}`);
      jsonRes(res, 200, {
        id,
        error: { code: INVALID_PARAMS, message: validationError.message },
      } satisfies RpcError);
      return;
    }

    const result = await tool.handler(params);
    jsonRes(res, 200, { id, result } satisfies RpcSuccess);
  } catch (err) {
    spanOutcome = "error";
    const message = err instanceof Error ? err.message : String(err);
    spanErrorMessage = sanitizeForLog(message);
    console.log(`[mcp-rpc] client=${safeClientId} method=${safeMethod} → error: ${spanErrorMessage}`);

    // Classify: caller-facing (bad-but-well-formed input, e.g. "project 'x' not
    // found") echoes its message under INVALID_PARAMS; everything else keeps the
    // masked INTERNAL_ERROR message — CodeQL-110 posture (info-exposure via error
    // message) is unchanged for the internal-fault branch. EXPOSE_INTERNAL_ERRORS
    // is NOT touched by this classification (Design constraint, Plan 94).
    const callerFacing = isCallerFacing(err);
    jsonRes(res, 200, {
      id,
      error: {
        code: callerFacing ? INVALID_PARAMS : INTERNAL_ERROR,
        message: callerFacing ? message : (EXPOSE_INTERNAL_ERRORS ? message : "internal error"),
      },
    } satisfies RpcError);
  } finally {
    const endSample = sampleNow();
    diagEmit({
      event: "activity-span",
      level: "info",
      spanType: "mcp-call",
      method: safeMethod,
      clientId: safeClientId,
      durationMs: Date.now() - spanStart,
      outcome: spanOutcome,
      startRssBytes: startSample.rssBytes,
      peakRssBytes: Math.max(startSample.rssBytes, endSample.rssBytes),
      endRssBytes: endSample.rssBytes,
      // provider tag: not source-specific at the RPC layer; set to undefined here.
      // Per-source provider info is tagged in the reindex activity span (queue.ts).
      provider: undefined,
      ...(spanOutcome === "error" && spanErrorMessage ? { error: spanErrorMessage } : {}),
    });
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
