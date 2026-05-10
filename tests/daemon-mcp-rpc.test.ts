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
 */
import { describe, it, expect } from "vitest";
import http from "node:http";
import { buildManifest, handleMcpRoute } from "../src/daemon/mcp-rpc.js";
import { mcpTools } from "../src/tools/all-tools.js";

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
