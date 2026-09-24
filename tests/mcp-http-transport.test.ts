/**
 * Real-protocol tests for the spec Streamable HTTP MCP transport at POST /mcp
 * (GitHub issue #102): a real SDK `Client` over `StreamableHTTPClientTransport`
 * against a real spawned daemon with `SCRYBE_DAEMON_MCP_HTTP=1`.
 *
 * The stdio-shim-parity assertions compare against a direct POST /mcp/rpc
 * call on the same daemon plus the shim's own {content:[{type:"text",
 * text: JSON.stringify(...)}]} shape (src/mcp-shim.ts jsonResult/
 * callToolErrorResult) — not a second spawned shim process.
 */
import { describe, it, expect, afterEach } from "vitest";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { startTempDaemon } from "./helpers/daemon.js";
import type { TempDaemon } from "./helpers/daemon.js";
import { mcpTools } from "../src/tools/all-tools.js";
import { toCallToolResult, isMcpHttpEnabled } from "../src/daemon/mcp-http.js";

let daemon: TempDaemon | null = null;
let dataDir: string | null = null;

afterEach(async () => {
  if (daemon) { await daemon.stop(); daemon = null; }
  if (dataDir) { try { rmSync(dataDir, { recursive: true, force: true }); } catch { /* ignore */ } dataDir = null; }
});

async function startDaemon(extraEnv: Record<string, string> = {}): Promise<TempDaemon> {
  dataDir = mkdtempSync(join(tmpdir(), "scrybe-mcp-http-"));
  writeFileSync(join(dataDir, "projects.json"), JSON.stringify([]), "utf8");
  daemon = await startTempDaemon({ dataDir, projects: [], extraEnv: { SCRYBE_DAEMON_MCP_HTTP: "1", ...extraEnv } });
  return daemon;
}

async function connectClient(port: number): Promise<Client> {
  const client = new Client({ name: "mcp-http-test-client", version: "0.0.0" });
  const transport = new StreamableHTTPClientTransport(new URL(`http://127.0.0.1:${port}/mcp`));
  await client.connect(transport);
  return client;
}

async function rpc(port: number, method: string, params: Record<string, unknown>): Promise<{ result?: unknown; error?: { code: number; message: string } }> {
  const res = await fetch(`http://127.0.0.1:${port}/mcp/rpc`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ id: 1, method, params }),
  });
  return (await res.json()) as { result?: unknown; error?: { code: number; message: string } };
}

describe("Streamable HTTP MCP transport — /mcp", () => {
  it("initialize succeeds and tools/list returns every mcpTools entry", async () => {
    const d = await startDaemon();
    const client = await connectClient(d.port);
    try {
      const { tools } = await client.listTools();
      expect(tools.length).toBe(mcpTools.length);
      const names = new Set(tools.map((t) => t.name));
      for (const tool of mcpTools) {
        expect(names.has(tool.spec.name), `tools/list missing: ${tool.spec.name}`).toBe(true);
      }
    } finally {
      await client.close();
    }
  });

  it("tools/call list_projects returns content identical to the stdio shim's mapping for the same call", async () => {
    const d = await startDaemon();
    const client = await connectClient(d.port);
    try {
      const result = await client.callTool({ name: "list_projects", arguments: {} });
      const rpcBody = await rpc(d.port, "list_projects", {});
      const expected = { content: [{ type: "text", text: JSON.stringify(rpcBody.result, null, 2) }] };
      expect(result).toEqual(expected);
    } finally {
      await client.close();
    }
  });

  it("a misspelled argument returns the same did-you-mean error text as /mcp/rpc", async () => {
    const d = await startDaemon();
    const client = await connectClient(d.port);
    try {
      const args = { project_ids: "myrepo", query: "auth flow" };
      const result = await client.callTool({ name: "search_code", arguments: args }) as {
        content: Array<{ type: string; text: string }>;
        isError?: boolean;
      };
      const rpcBody = await rpc(d.port, "search_code", args);

      expect(rpcBody.error?.code).toBe(-32602);
      expect(rpcBody.error?.message).toContain("unknown key 'project_ids'");
      expect(rpcBody.error?.message).toContain("did you mean 'project_id'");

      expect(result.isError).toBe(true);
      expect(JSON.parse(result.content[0]!.text)).toEqual({ error: rpcBody.error?.message });
    } finally {
      await client.close();
    }
  });

  it("two concurrent clients both succeed", async () => {
    const d = await startDaemon();
    const [c1, c2] = await Promise.all([connectClient(d.port), connectClient(d.port)]);
    try {
      const [r1, r2] = await Promise.all([c1.listTools(), c2.listTools()]);
      expect(r1.tools.length).toBe(mcpTools.length);
      expect(r2.tools.length).toBe(mcpTools.length);
    } finally {
      await c1.close();
      await c2.close();
    }
  });

  it("GET /mcp is 405", async () => {
    const d = await startDaemon();
    const res = await fetch(`http://127.0.0.1:${d.port}/mcp`);
    expect(res.status).toBe(405);
  });

  it("DELETE /mcp is 405", async () => {
    const d = await startDaemon();
    const res = await fetch(`http://127.0.0.1:${d.port}/mcp`, { method: "DELETE" });
    expect(res.status).toBe(405);
  });

  it("with the setting unset, /mcp is 404", async () => {
    dataDir = mkdtempSync(join(tmpdir(), "scrybe-mcp-http-off-"));
    writeFileSync(join(dataDir, "projects.json"), JSON.stringify([]), "utf8");
    daemon = await startTempDaemon({ dataDir, projects: [] });
    const res = await fetch(`http://127.0.0.1:${daemon.port}/mcp`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Accept: "application/json, text/event-stream" },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list" }),
    });
    expect(res.status).toBe(404);
  });
});

describe("toCallToolResult — job mapping (unit, #102)", () => {
  it("returns {job_id, status: started} immediately and never awaits the job's awaitable", async () => {
    const awaitable = Promise.reject(new Error("must not be awaited by an HTTP caller"));
    // Prevent an unrelated "unhandled rejection" if something ever does await it.
    awaitable.catch(() => {});

    const result = await toCallToolResult({ ok: true, result: { jobId: "job-123", awaitable } });
    expect(result).toEqual({ content: [{ type: "text", text: JSON.stringify({ job_id: "job-123", status: "started" }, null, 2) }] });
  });

  it("passes a plain (non-job) result through unchanged", async () => {
    const result = await toCallToolResult({ ok: true, result: { hello: "world" } });
    expect(result).toEqual({ content: [{ type: "text", text: JSON.stringify({ hello: "world" }, null, 2) }] });
  });
});

describe("SCRYBE_DAEMON_MCP_HTTP — accepted values (unit, #102)", () => {
  const ORIGINAL = process.env["SCRYBE_DAEMON_MCP_HTTP"];
  afterEach(() => {
    if (ORIGINAL === undefined) delete process.env["SCRYBE_DAEMON_MCP_HTTP"];
    else process.env["SCRYBE_DAEMON_MCP_HTTP"] = ORIGINAL;
  });

  it("is enabled for '1' and 'true' (case-insensitive, trimmed), and nothing else", () => {
    for (const on of ["1", "true", "TRUE", " true ", " 1 "]) {
      process.env["SCRYBE_DAEMON_MCP_HTTP"] = on;
      expect(isMcpHttpEnabled(), `expected '${on}' to enable`).toBe(true);
    }
    for (const off of [undefined, "", "0", "false", "yes", "2"]) {
      if (off === undefined) delete process.env["SCRYBE_DAEMON_MCP_HTTP"];
      else process.env["SCRYBE_DAEMON_MCP_HTTP"] = off;
      expect(isMcpHttpEnabled(), `expected '${off}' to stay disabled`).toBe(false);
    }
  });
});
