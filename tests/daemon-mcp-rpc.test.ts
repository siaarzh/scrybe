/**
 * Unit tests for daemon-side MCP-over-HTTP routes.
 *
 * Covers:
 *   - manifest shape contains all mcpTools entries
 *   - POST /mcp/rpc happy path (queue_status)
 *   - POST /mcp/rpc unknown method → -32601
 *   - POST /mcp/rpc malformed body (missing id/method) → -32600
 *   - POST /mcp/rpc invalid JSON body → -32600
 *   - GET /mcp/manifest returns correct structure
 *   - X-Scrybe-Client-Id header is accepted without error
 *   - Plan 94 Slice 1: boundary param validation (-32602), caller-facing vs
 *     internal error classification (-32603 stays masked), and the
 *     activity-span error-message field
 */
import { describe, it, expect } from "vitest";
import http from "node:http";
import { existsSync, mkdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { buildManifest, handleMcpRoute } from "../src/daemon/mcp-rpc.js";
import { mcpTools } from "../src/tools/all-tools.js";
import { config } from "../src/config.js";

// `config.dataDir` is resolved once at this file's static-import time, from
// the SAME module graph mcp-rpc.ts's diagEmit calls write through (events.ts
// also imports config.js statically). isolate.ts's per-test SCRYBE_DATA_DIR +
// vi.resetModules() only affects *dynamic* re-imports, not this file's
// already-bound static imports — so the log path must be derived from this
// bound `config`, not read fresh from process.env per test.
const daemonLogPath = join(config.dataDir, "daemon-log.jsonl");

// In production the daemon creates dataDir at startup; the in-process test
// server below skips that bootstrap. On a fresh machine (CI runners) the dir
// doesn't exist, diagEmit's appendFileSync throws ENOENT and swallows it, and
// the span-assertion tests fail with "expected undefined to be defined".
mkdirSync(config.dataDir, { recursive: true });

function readJsonlLines(logPath: string): Record<string, unknown>[] {
  if (!existsSync(logPath)) return [];
  return readFileSync(logPath, "utf8")
    .trim()
    .split("\n")
    .filter(Boolean)
    .map((l) => { try { return JSON.parse(l); } catch { return null; } })
    .filter(Boolean) as Record<string, unknown>[];
}

// ─── Lightweight in-process HTTP server ────────────────────────────────────

function startTestServer(): Promise<{ port: number; close: () => Promise<void> }> {
  return new Promise((resolve, reject) => {
    const server = http.createServer((req, res) => {
      handleMcpRoute(req, res).then((handled) => {
        if (!handled) {
          res.writeHead(404, { "Content-Type": "application/json" });
          res.end(JSON.stringify({ error: "not found" }));
        }
      }).catch((err) => {
        if (!res.headersSent) {
          res.writeHead(500, { "Content-Type": "application/json" });
          res.end(JSON.stringify({ error: String(err) }));
        }
      });
    });

    server.listen(0, "127.0.0.1", () => {
      const addr = server.address() as { port: number };
      resolve({
        port: addr.port,
        close: () => new Promise<void>((res) => server.close(() => res())),
      });
    });

    server.once("error", reject);
  });
}

async function get(port: number, path: string, headers: Record<string, string> = {}): Promise<{ status: number; body: unknown }> {
  const res = await fetch(`http://127.0.0.1:${port}${path}`, { headers });
  const body = await res.json();
  return { status: res.status, body };
}

async function post(port: number, path: string, body: unknown, headers: Record<string, string> = {}): Promise<{ status: number; body: unknown }> {
  const res = await fetch(`http://127.0.0.1:${port}${path}`, {
    method: "POST",
    headers: { "Content-Type": "application/json", ...headers },
    body: JSON.stringify(body),
  });
  const respBody = await res.json();
  return { status: res.status, body: respBody };
}

async function postRaw(port: number, path: string, raw: string): Promise<{ status: number; body: unknown }> {
  const res = await fetch(`http://127.0.0.1:${port}${path}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: raw,
  });
  const respBody = await res.json();
  return { status: res.status, body: respBody };
}

// ─── buildManifest unit tests (no HTTP) ────────────────────────────────────

describe("buildManifest", () => {
  it("returns daemon_version string", () => {
    const m = buildManifest();
    expect(typeof m.daemon_version).toBe("string");
    expect(m.daemon_version.length).toBeGreaterThan(0);
  });

  it("tools array matches mcpTools registry length", () => {
    const m = buildManifest();
    expect(m.tools.length).toBe(mcpTools.length);
  });

  it("every mcpTools entry appears in manifest by name", () => {
    const m = buildManifest();
    const names = new Set(m.tools.map((t) => t.name));
    for (const tool of mcpTools) {
      expect(names.has(tool.spec.name), `manifest missing tool: ${tool.spec.name}`).toBe(true);
    }
  });

  it("each manifest tool has name, description, inputSchema", () => {
    const m = buildManifest();
    for (const t of m.tools) {
      expect(typeof t.name).toBe("string");
      expect(typeof t.description).toBe("string");
      expect(typeof t.inputSchema).toBe("object");
      expect(t.inputSchema).not.toBeNull();
    }
  });
});

// ─── HTTP route tests ──────────────────────────────────────────────────────

describe("GET /mcp/manifest", () => {
  it("returns 200 with manifest shape", async () => {
    const srv = await startTestServer();
    try {
      const { status, body } = await get(srv.port, "/mcp/manifest");
      const m = body as Record<string, unknown>;
      expect(status).toBe(200);
      expect(typeof m["daemon_version"]).toBe("string");
      expect(Array.isArray(m["tools"])).toBe(true);
      const tools = m["tools"] as Array<Record<string, unknown>>;
      expect(tools.length).toBe(mcpTools.length);
    } finally {
      await srv.close();
    }
  });

  it("manifest tools contain all mcpTools names", async () => {
    const srv = await startTestServer();
    try {
      const { body } = await get(srv.port, "/mcp/manifest");
      const m = body as Record<string, unknown>;
      const names = new Set((m["tools"] as Array<{ name: string }>).map((t) => t.name));
      for (const tool of mcpTools) {
        expect(names.has(tool.spec.name), `missing: ${tool.spec.name}`).toBe(true);
      }
    } finally {
      await srv.close();
    }
  });
});

describe("POST /mcp/rpc — happy path", () => {
  it("queue_status returns {id, result} with running and queued arrays", async () => {
    const srv = await startTestServer();
    try {
      const { status, body } = await post(srv.port, "/mcp/rpc", {
        id: 1,
        method: "queue_status",
        params: {},
      });
      const r = body as Record<string, unknown>;
      expect(status).toBe(200);
      expect(r["id"]).toBe(1);
      expect(Object.prototype.hasOwnProperty.call(r, "result")).toBe(true);
      expect(Object.prototype.hasOwnProperty.call(r, "error")).toBe(false);
    } finally {
      await srv.close();
    }
  });

  it("accepts X-Scrybe-Client-Id header without error", async () => {
    const srv = await startTestServer();
    try {
      const { status, body } = await post(
        srv.port,
        "/mcp/rpc",
        { id: 2, method: "queue_status", params: {} },
        { "X-Scrybe-Client-Id": "test-client-abc" }
      );
      const r = body as Record<string, unknown>;
      expect(status).toBe(200);
      expect(r["id"]).toBe(2);
      expect(Object.prototype.hasOwnProperty.call(r, "result")).toBe(true);
    } finally {
      await srv.close();
    }
  });

  it("list_projects returns {id, result} with projects array", async () => {
    const srv = await startTestServer();
    try {
      const { status, body } = await post(srv.port, "/mcp/rpc", {
        id: 3,
        method: "list_projects",
        params: {},
      });
      const r = body as Record<string, unknown>;
      expect(status).toBe(200);
      expect(r["id"]).toBe(3);
      expect(Object.prototype.hasOwnProperty.call(r, "result")).toBe(true);
    } finally {
      await srv.close();
    }
  });
});

describe("POST /mcp/rpc — unknown method", () => {
  it("returns {id, error: {code: -32601}} for unknown method", async () => {
    const srv = await startTestServer();
    try {
      const { status, body } = await post(srv.port, "/mcp/rpc", {
        id: 99,
        method: "this_tool_does_not_exist",
        params: {},
      });
      const r = body as Record<string, unknown>;
      expect(status).toBe(200);
      expect(r["id"]).toBe(99);
      expect(Object.prototype.hasOwnProperty.call(r, "error")).toBe(true);
      const err = r["error"] as Record<string, unknown>;
      expect(err["code"]).toBe(-32601);
      expect(typeof err["message"]).toBe("string");
    } finally {
      await srv.close();
    }
  });
});

describe("POST /mcp/rpc — malformed body", () => {
  it("returns {id, error: {code: -32600}} when method is missing", async () => {
    const srv = await startTestServer();
    try {
      const { status, body } = await post(srv.port, "/mcp/rpc", {
        id: 10,
        params: {},
        // method deliberately omitted
      });
      const r = body as Record<string, unknown>;
      expect(status).toBe(200);
      expect(Object.prototype.hasOwnProperty.call(r, "error")).toBe(true);
      const err = r["error"] as Record<string, unknown>;
      expect(err["code"]).toBe(-32600);
    } finally {
      await srv.close();
    }
  });

  it("returns {id: null, error: {code: -32600}} for invalid JSON body", async () => {
    const srv = await startTestServer();
    try {
      const { status, body } = await postRaw(srv.port, "/mcp/rpc", "{not valid json");
      const r = body as Record<string, unknown>;
      expect(status).toBe(200);
      expect(r["id"]).toBeNull();
      expect(Object.prototype.hasOwnProperty.call(r, "error")).toBe(true);
      const err = r["error"] as Record<string, unknown>;
      expect(err["code"]).toBe(-32600);
    } finally {
      await srv.close();
    }
  });

  it("returns error when id is missing from body", async () => {
    const srv = await startTestServer();
    try {
      const { status, body } = await post(srv.port, "/mcp/rpc", {
        method: "queue_status",
        params: {},
        // id deliberately omitted
      });
      const r = body as Record<string, unknown>;
      expect(status).toBe(200);
      expect(Object.prototype.hasOwnProperty.call(r, "error")).toBe(true);
      const err = r["error"] as Record<string, unknown>;
      expect(err["code"]).toBe(-32600);
    } finally {
      await srv.close();
    }
  });
});

describe("handleMcpRoute — route matching", () => {
  it("returns false for non-MCP paths (does not handle them)", async () => {
    const srv = await startTestServer();
    try {
      const { status } = await get(srv.port, "/health");
      // The test server returns 404 for unhandled routes
      expect(status).toBe(404);
    } finally {
      await srv.close();
    }
  });

  it("GET /mcp/manifest is handled (not 404)", async () => {
    const srv = await startTestServer();
    try {
      const { status } = await get(srv.port, "/mcp/manifest");
      expect(status).toBe(200);
    } finally {
      await srv.close();
    }
  });
});

// ─── Plan 94 Slice 1 — boundary param validation ───────────────────────────

describe("POST /mcp/rpc — boundary param validation (-32602)", () => {
  it("rejects an unknown key with a did-you-mean pointing at the real field (project_ids → project_id)", async () => {
    const srv = await startTestServer();
    try {
      const { status, body } = await post(srv.port, "/mcp/rpc", {
        id: 20,
        method: "search_code",
        // recurrence #2: invented arg name instead of project_id
        params: { project_ids: "myrepo", query: "auth flow" },
      });
      const r = body as Record<string, unknown>;
      expect(status).toBe(200);
      const err = r["error"] as Record<string, unknown>;
      expect(err["code"]).toBe(-32602);
      expect(err["message"]).toContain("unknown key 'project_ids'");
      expect(err["message"]).toContain("project_id");
    } finally {
      await srv.close();
    }
  });

  it("rejects an unknown key with a did-you-mean pointing at the real field (symbol → symbol_name)", async () => {
    const srv = await startTestServer();
    try {
      const { status, body } = await post(srv.port, "/mcp/rpc", {
        id: 21,
        method: "lookup_symbol",
        params: { project_id: "myrepo", symbol: "getName" },
      });
      const r = body as Record<string, unknown>;
      expect(status).toBe(200);
      const err = r["error"] as Record<string, unknown>;
      expect(err["code"]).toBe(-32602);
      expect(err["message"]).toContain("unknown key 'symbol'");
      expect(err["message"]).toContain("symbol_name");
    } finally {
      await srv.close();
    }
  });

  it("rejects a missing required field, naming it", async () => {
    const srv = await startTestServer();
    try {
      const { status, body } = await post(srv.port, "/mcp/rpc", {
        id: 22,
        method: "search_code",
        params: { query: "auth flow" }, // project_id omitted
      });
      const r = body as Record<string, unknown>;
      expect(status).toBe(200);
      const err = r["error"] as Record<string, unknown>;
      expect(err["code"]).toBe(-32602);
      expect(err["message"]).toContain("missing required 'project_id'");
    } finally {
      await srv.close();
    }
  });

  it("rejects a null value for a required field (treated as absent, not passed to handler)", async () => {
    const srv = await startTestServer();
    try {
      const { status, body } = await post(srv.port, "/mcp/rpc", {
        id: 24,
        method: "search_code",
        params: { project_id: null, query: "auth flow" }, // null must not slip through
      });
      const r = body as Record<string, unknown>;
      expect(status).toBe(200);
      const err = r["error"] as Record<string, unknown>;
      expect(err["code"]).toBe(-32602);
      expect(err["message"]).toContain("missing required 'project_id'");
    } finally {
      await srv.close();
    }
  });

  it("rejects a wrong-type field, naming it", async () => {
    const srv = await startTestServer();
    try {
      const { status, body } = await post(srv.port, "/mcp/rpc", {
        id: 23,
        method: "search_code",
        // recurrence #2: limit-shaped value passed under the wrong (but real) key
        params: { project_id: "myrepo", query: "auth flow", top_k: "10" },
      });
      const r = body as Record<string, unknown>;
      expect(status).toBe(200);
      const err = r["error"] as Record<string, unknown>;
      expect(err["code"]).toBe(-32602);
      expect(err["message"]).toContain("'top_k'");
      expect(err["message"]).toContain("number");
    } finally {
      await srv.close();
    }
  });

  it("rejects an out-of-enum value, naming it", async () => {
    const srv = await startTestServer();
    try {
      const { status, body } = await post(srv.port, "/mcp/rpc", {
        id: 24,
        method: "lookup_symbol",
        params: { project_id: "myrepo", symbol_name: "getName", match: "fuzzy" },
      });
      const r = body as Record<string, unknown>;
      expect(status).toBe(200);
      const err = r["error"] as Record<string, unknown>;
      expect(err["code"]).toBe(-32602);
      expect(err["message"]).toContain("'match'");
    } finally {
      await srv.close();
    }
  });

  it("a validation failure still emits an activity-span (not silently dropped)", async () => {
    const srv = await startTestServer();
    try {
      // daemonLogPath is a real, persistent, cross-run file (see comment on its
      // declaration) — tag this call with a unique clientId and take the LAST
      // matching record, so stale entries from other runs/tests can't be picked
      // up by a bare event/spanType/method match.
      const clientId = `test-span-validation-${Date.now()}`;
      await post(
        srv.port,
        "/mcp/rpc",
        { id: 25, method: "search_code", params: { project_ids: "myrepo", query: "auth flow" } },
        { "X-Scrybe-Client-Id": clientId }
      );
      const recs = readJsonlLines(daemonLogPath);
      const spanRec = recs
        .filter((r) => r["event"] === "activity-span" && r["spanType"] === "mcp-call" && r["clientId"] === clientId)
        .at(-1);
      expect(spanRec).toBeDefined();
      expect(spanRec!["method"]).toBe("search_code");
      expect(spanRec!["outcome"]).toBe("error");
      expect(typeof spanRec!["error"]).toBe("string");
      expect(spanRec!["error"] as string).toContain("unknown key 'project_ids'");
    } finally {
      await srv.close();
    }
  });
});

// ─── Plan 94 Slice 1 — internal-fault masking is preserved ─────────────────

describe("POST /mcp/rpc — internal faults stay masked (-32603, CodeQL-110)", () => {
  it("a handler throwing a plain (non-caller-facing) Error still returns \"internal error\"", async () => {
    const srv = await startTestServer();
    try {
      // gc.ts throws a plain `Error` (no callerFacing marker) for an unknown
      // project_id — this is a real, well-formed-shape call whose handler
      // faults, exercising the classify-else-mask branch of the catch.
      const { status, body } = await post(srv.port, "/mcp/rpc", {
        id: 26,
        method: "gc",
        params: { project_id: "definitely-not-a-registered-project-94" },
      });
      const r = body as Record<string, unknown>;
      expect(status).toBe(200);
      const err = r["error"] as Record<string, unknown>;
      expect(err["code"]).toBe(-32603);
      expect(err["message"]).toBe("internal error");
    } finally {
      await srv.close();
    }
  });

  it("the masked call's activity-span still carries the real (sanitized) message", async () => {
    const srv = await startTestServer();
    try {
      const clientId = `test-span-masked-${Date.now()}`;
      await post(
        srv.port,
        "/mcp/rpc",
        { id: 27, method: "gc", params: { project_id: "definitely-not-a-registered-project-94" } },
        { "X-Scrybe-Client-Id": clientId }
      );
      const recs = readJsonlLines(daemonLogPath);
      const spanRec = recs
        .filter((r) => r["event"] === "activity-span" && r["spanType"] === "mcp-call" && r["clientId"] === clientId)
        .at(-1);
      expect(spanRec).toBeDefined();
      expect(spanRec!["method"]).toBe("gc");
      expect(spanRec!["outcome"]).toBe("error");
      // the wire response says "internal error", but the span keeps the real message
      expect(spanRec!["error"] as string).toContain("definitely-not-a-registered-project-94");
    } finally {
      await srv.close();
    }
  });
});

// ─── Plan 94 Slice 2 — search.ts semantic caller-errors are echoed (-32602) ─

describe("POST /mcp/rpc — search_code with a well-formed but nonexistent project_id is echoed, not masked", () => {
  it("returns -32602 with the field-naming \"Project 'X' not found\" message (not \"internal error\")", async () => {
    const srv = await startTestServer();
    try {
      const { status, body } = await post(srv.port, "/mcp/rpc", {
        id: 28,
        method: "search_code",
        params: { project_id: "definitely-not-a-registered-project-94", query: "auth flow" },
      });
      const r = body as Record<string, unknown>;
      expect(status).toBe(200);
      const err = r["error"] as Record<string, unknown>;
      expect(err["code"]).toBe(-32602);
      expect(err["message"]).toBe("Project 'definitely-not-a-registered-project-94' not found");
    } finally {
      await srv.close();
    }
  });
});
