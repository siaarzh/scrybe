/**
 * Integration tests for the Host/Origin gate wired into every daemon route
 * (GitHub issue #102). Binds a real in-process HTTP server (ephemeral port,
 * SCRYBE_DAEMON_PORT=0) — no real sockets or the shared daemon's port are
 * touched. Uses node:http `request` (not `fetch`) so a foreign `Host` header
 * can actually be forged; fetch refuses to set it.
 */
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import http from "node:http";
import net from "node:net";

const ORIGINAL_PORT_ENV = process.env["SCRYBE_DAEMON_PORT"];
const ORIGINAL_ALLOWED_HOSTS = process.env["SCRYBE_DAEMON_ALLOWED_HOSTS"];

beforeEach(() => {
  process.env["SCRYBE_DAEMON_PORT"] = "0"; // ephemeral — never touches the real daemon's port
  delete process.env["SCRYBE_DAEMON_ALLOWED_HOSTS"];
});

afterEach(async () => {
  const { stopHttpServer } = await import("../src/daemon/http-server.js");
  await stopHttpServer();
  if (ORIGINAL_PORT_ENV === undefined) delete process.env["SCRYBE_DAEMON_PORT"];
  else process.env["SCRYBE_DAEMON_PORT"] = ORIGINAL_PORT_ENV;
  if (ORIGINAL_ALLOWED_HOSTS === undefined) delete process.env["SCRYBE_DAEMON_ALLOWED_HOSTS"];
  else process.env["SCRYBE_DAEMON_ALLOWED_HOSTS"] = ORIGINAL_ALLOWED_HOSTS;
});

interface RawResponse {
  status: number;
  headers: http.IncomingHttpHeaders;
  body: string;
}

/** Sends a raw request, resolving as soon as response headers arrive (never waits for SSE bodies to end). */
function rawRequest(
  port: number,
  opts: { method?: string; path: string; host?: string; origin?: string; body?: string; contentType?: string }
): Promise<RawResponse> {
  return new Promise((resolve, reject) => {
    const headers: Record<string, string> = {};
    if (opts.host !== undefined) headers["Host"] = opts.host;
    if (opts.origin !== undefined) headers["Origin"] = opts.origin;
    if (opts.body !== undefined) headers["Content-Type"] = opts.contentType ?? "application/json";

    const req = http.request(
      { hostname: "127.0.0.1", port, path: opts.path, method: opts.method ?? "GET", headers },
      (res) => {
        const chunks: Buffer[] = [];
        res.on("data", (c: Buffer) => chunks.push(c));
        // Resolve on the first chunk (or a short grace period) for streaming
        // routes like /events, which never end the response on their own.
        const finish = () => {
          req.destroy();
          resolve({ status: res.statusCode ?? 0, headers: res.headers, body: Buffer.concat(chunks).toString("utf8") });
        };
        res.once("data", finish);
        res.once("end", finish);
        setTimeout(finish, 500);
      }
    );
    req.on("error", reject);
    if (opts.body !== undefined) req.write(opts.body);
    req.end();
  });
}

/**
 * Node's own HTTP/1.1 parser rejects a request with no `Host` header before
 * it ever reaches our handler, so a real HTTP/1.0 request over a raw socket
 * is the only way to exercise the "no Host at all" path.
 */
function rawHttp10Request(port: number, path: string): Promise<{ status: number; body: string }> {
  return new Promise((resolve, reject) => {
    const sock = net.connect(port, "127.0.0.1", () => {
      sock.write(`GET ${path} HTTP/1.0\r\nConnection: close\r\n\r\n`);
    });
    let data = "";
    sock.on("data", (d: Buffer) => { data += d.toString("utf8"); });
    sock.on("end", () => {
      const [statusLine, ...rest] = data.split("\r\n\r\n")[0]?.split("\r\n") ?? [];
      const status = Number(statusLine?.split(" ")[1] ?? 0);
      const body = data.split("\r\n\r\n").slice(1).join("\r\n\r\n");
      void rest;
      resolve({ status, body });
    });
    sock.on("error", reject);
  });
}

async function startServer(): Promise<number> {
  const { startHttpServer } = await import("../src/daemon/http-server.js");
  const { port } = await startHttpServer({ startedAt: new Date() });
  return port;
}

const ROUTES: Array<{ method: string; path: string; body?: string }> = [
  { method: "GET", path: "/health" },
  { method: "GET", path: "/status" },
  { method: "GET", path: "/events" },
  { method: "POST", path: "/mcp/rpc", body: JSON.stringify({ id: 1, method: "queue_status", params: {} }) },
];

describe("Host/Origin gate — every route", () => {
  for (const route of ROUTES) {
    it(`rejects a foreign Host on ${route.method} ${route.path}`, async () => {
      const port = await startServer();
      const res = await rawRequest(port, { method: route.method, path: route.path, host: "evil.example.com", body: route.body });
      expect(res.status).toBe(403);
    });

    it(`rejects a foreign Origin on ${route.method} ${route.path}`, async () => {
      const port = await startServer();
      const res = await rawRequest(port, {
        method: route.method,
        path: route.path,
        host: `127.0.0.1:${port}`,
        origin: "https://evil.example.com",
        body: route.body,
      });
      expect(res.status).toBe(403);
    });

    it(`allows ${route.method} ${route.path} with no Origin and an allowed Host`, async () => {
      const port = await startServer();
      const res = await rawRequest(port, { method: route.method, path: route.path, host: `127.0.0.1:${port}`, body: route.body });
      expect(res.status).not.toBe(403);
    });
  }

  it("rejects a missing Host header (HTTP/1.0, no Host at all)", async () => {
    const port = await startServer();
    const res = await rawHttp10Request(port, "/health");
    expect(res.status).toBe(403);
  });

  it("allows a name added via SCRYBE_DAEMON_ALLOWED_HOSTS", async () => {
    process.env["SCRYBE_DAEMON_ALLOWED_HOSTS"] = "proxy.internal.example";
    const port = await startServer();
    const res = await rawRequest(port, { path: "/health", host: "proxy.internal.example" });
    expect(res.status).not.toBe(403);
  });

  it("still allows the built-ins when SCRYBE_DAEMON_ALLOWED_HOSTS omits them", async () => {
    process.env["SCRYBE_DAEMON_ALLOWED_HOSTS"] = "only-this.example";
    const port = await startServer();
    const res = await rawRequest(port, { path: "/health", host: `127.0.0.1:${port}` });
    expect(res.status).not.toBe(403);
    const res2 = await rawRequest(port, { path: "/health", host: "localhost" });
    expect(res2.status).not.toBe(403);
  });

  it("never returns Access-Control-Allow-Origin, on GET or SSE", async () => {
    const port = await startServer();
    const statusRes = await rawRequest(port, { path: "/status", host: `127.0.0.1:${port}` });
    expect(statusRes.headers["access-control-allow-origin"]).toBeUndefined();

    const eventsRes = await rawRequest(port, { path: "/events", host: `127.0.0.1:${port}` });
    expect(eventsRes.headers["access-control-allow-origin"]).toBeUndefined();
  });

  it("rejects a text/plain POST to /mcp/rpc carrying a browser Origin (CORS 'simple' request)", async () => {
    const port = await startServer();
    const res = await rawRequest(port, {
      method: "POST",
      path: "/mcp/rpc",
      host: `127.0.0.1:${port}`,
      origin: "http://localhost:5173",
      body: JSON.stringify({ id: 1, method: "queue_status", params: {} }),
      contentType: "text/plain",
    });
    expect(res.status).toBe(403);
  });

  it("rejects POST /shutdown carrying a browser Origin, and the daemon stays up", async () => {
    const port = await startServer();
    const res = await rawRequest(port, {
      method: "POST",
      path: "/shutdown",
      host: `127.0.0.1:${port}`,
      origin: "http://localhost:5173",
    });
    expect(res.status).toBe(403);

    const health = await rawRequest(port, { path: "/health", host: `127.0.0.1:${port}` });
    expect(health.status).not.toBe(403);
  });
});
