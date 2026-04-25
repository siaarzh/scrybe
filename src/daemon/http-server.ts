/**
 * HTTP API server for the scrybe daemon.
 * Phase 2: port binding, all §7 endpoints, SSE /events stream, pinned-branches CRUD.
 * Later phases (3–6) wire in job queue, watcher health, and fetch-poller state.
 */
import http from "node:http";
import { VERSION, config } from "../config.js";
import { listProjects } from "../registry.js";
import {
  addPinned, removePinned, clearPinned, listPinned,
  InvalidSourceTypeError, ProjectNotFoundError, SourceNotFoundError,
} from "../pinned-branches.js";
import { getQueueStats } from "./queue.js";
import { getWatcherHealth } from "./watcher.js";
import { getGitWatcherHealth, getCachedBranch } from "./git-watcher.js";

// ─── Public types ──────────────────────────────────────────────────────────

export interface DaemonEvent {
  ts: string;
  level: "info" | "warn" | "error";
  event:
    | "job.started" | "job.completed" | "job.failed" | "job.cancelled"
    | "watcher.event" | "state.changed" | "watcher.unhealthy"
    | "pinned.changed";
  projectId?: string;
  sourceId?: string;
  branch?: string;
  durationMs?: number;
  error?: { message: string; code?: string };
  detail?: Record<string, unknown>;
}

export type DaemonState = "hot" | "cold" | "paused";

export interface DaemonStatus {
  version: string;
  pid: number;
  port: number;
  uptimeMs: number;
  state: DaemonState;
  startedAt: string;
  dataDir: string;
  projects: Array<{
    projectId: string;
    rootPath: string;
    currentBranch: string | null;
    watcherHealthy: boolean;
    gitWatcherHealthy: boolean;
    lastIndexedAt: string | null;
    lastBranch: string | null;
    queueDepth: number;
  }>;
  queue: {
    active: number;
    pending: number;
    maxConcurrent: number;
  };
  recentEvents: DaemonEvent[];
  lastError: DaemonEvent | null;
  // M-D11: on-demand lifecycle fields
  clientCount?: number;
  mode?: "on-demand" | "always-on";
  gracePeriodRemainingMs?: number | null;
}

export interface KickRequest {
  projectId?: string;
  sourceId?: string;
  branch?: string;
  mode?: "full" | "incremental";
}

export interface KickResponse {
  jobs: Array<{ jobId: string; projectId: string; sourceId: string; branch: string }>;
}

// ─── Module state ──────────────────────────────────────────────────────────

const DEFAULT_PORT = 58451;
const RING_SIZE = 100;

let _state: DaemonState = "cold";
let _startedAt = new Date();
let _port = 0;
const _ring: DaemonEvent[] = [];
const _sseClients = new Map<number, http.ServerResponse>();
let _sseSeq = 0;
let _server: http.Server | null = null;
let _onShutdown: (() => void) | undefined;
let _onKick: ((r: KickRequest) => Promise<KickResponse>) | undefined;
let _onHeartbeat: ((clientId: string, pid: number) => void) | undefined;
let _onUnregister: ((clientId: string) => void) | undefined;
let _getClientCount: (() => number) | undefined;
let _getMode: (() => "on-demand" | "always-on") | undefined;
let _getGracePeriodRemainingMs: (() => number | null) | undefined;

// ─── Public API ────────────────────────────────────────────────────────────

export function pushEvent(ev: DaemonEvent): void {
  _ring.push(ev);
  if (_ring.length > RING_SIZE) _ring.shift();
  const data = `data: ${JSON.stringify(ev)}\n\n`;
  for (const [id, res] of _sseClients) {
    try {
      res.write(data);
    } catch {
      _sseClients.delete(id);
    }
  }
}

export function setDaemonState(s: DaemonState): void {
  _state = s;
  pushEvent({
    ts: new Date().toISOString(),
    level: "info",
    event: "state.changed",
    detail: { state: s },
  });
}

export function getPort(): number {
  return _port;
}

export async function startHttpServer(opts: {
  startedAt: Date;
  onShutdown?: () => void;
  onKick?: (r: KickRequest) => Promise<KickResponse>;
  onHeartbeat?: (clientId: string, pid: number) => void;
  onUnregister?: (clientId: string) => void;
  getClientCount?: () => number;
  getMode?: () => "on-demand" | "always-on";
  getGracePeriodRemainingMs?: () => number | null;
}): Promise<{ port: number }> {
  _startedAt = opts.startedAt;
  _onShutdown = opts.onShutdown;
  _onKick = opts.onKick;
  _onHeartbeat = opts.onHeartbeat;
  _onUnregister = opts.onUnregister;
  _getClientCount = opts.getClientCount;
  _getMode = opts.getMode;
  _getGracePeriodRemainingMs = opts.getGracePeriodRemainingMs;
  _state = "cold";

  _server = http.createServer((req, res) => {
    handle(req, res).catch((err) => {
      if (!res.headersSent) {
        res.writeHead(500, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ error: String(err) }));
      }
    });
  });

  const portEnv = process.env["SCRYBE_DAEMON_PORT"];
  const desired = portEnv != null ? parseInt(portEnv, 10) : DEFAULT_PORT;
  _port = await bindTo(desired);
  return { port: _port };
}

export function stopHttpServer(): Promise<void> {
  return new Promise((resolve) => {
    for (const res of _sseClients.values()) {
      try { res.end(); } catch { /* ignore */ }
    }
    _sseClients.clear();

    if (!_server) { resolve(); return; }
    const s = _server;
    _server = null;
    s.close(() => resolve());
  });
}

// ─── Internal ──────────────────────────────────────────────────────────────

async function bindTo(desired: number): Promise<number> {
  const tryBind = (port: number): Promise<number> =>
    new Promise((resolve, reject) => {
      const onError = (err: Error) => {
        _server!.removeListener("error", onError);
        reject(err);
      };
      _server!.once("error", onError);
      _server!.listen(port, "127.0.0.1", () => {
        _server!.removeListener("error", onError);
        resolve((_server!.address() as { port: number }).port);
      });
    });

  if (desired === DEFAULT_PORT) {
    try {
      return await tryBind(DEFAULT_PORT);
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code === "EADDRINUSE") {
        return await tryBind(0);
      }
      throw e;
    }
  }
  return await tryBind(desired);
}

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

function buildStatus(): DaemonStatus {
  const projects = listProjects();
  return {
    version: VERSION,
    pid: process.pid,
    port: _port,
    uptimeMs: Date.now() - _startedAt.getTime(),
    state: _state,
    startedAt: _startedAt.toISOString(),
    dataDir: config.dataDir,
    projects: projects.map((p) => {
      const codeSource = p.sources.find((s) => s.source_config.type === "code");
      let rootPath = "";
      if (codeSource && codeSource.source_config.type === "code") {
        rootPath = (codeSource.source_config as { type: "code"; root_path: string }).root_path;
      }
      const fsHealth = getWatcherHealth();
      const gitHealth = getGitWatcherHealth();
      return {
        projectId: p.id,
        rootPath,
        currentBranch: getCachedBranch(p.id),
        watcherHealthy: fsHealth.get(p.id) ?? false,
        gitWatcherHealthy: gitHealth.get(p.id) ?? false,
        lastIndexedAt: codeSource?.last_indexed ?? null,
        lastBranch: getCachedBranch(p.id),
        queueDepth: 0,
      };
    }),
    queue: getQueueStats(),
    recentEvents: _ring.slice(-10),
    lastError: _ring.filter((e) => e.level === "error").at(-1) ?? null,
    clientCount: _getClientCount?.() ?? 0,
    mode: _getMode?.() ?? "on-demand",
    gracePeriodRemainingMs: _getGracePeriodRemainingMs?.() ?? null,
  };
}

const PINNED_RE = /^\/projects\/([^/]+)\/sources\/([^/]+)\/pinned-branches$/;

async function handle(
  req: http.IncomingMessage,
  res: http.ServerResponse
): Promise<void> {
  const url = new URL(req.url ?? "/", "http://localhost");
  const method = req.method?.toUpperCase() ?? "GET";
  const path = url.pathname;

  if (method === "GET") res.setHeader("Access-Control-Allow-Origin", "*");

  if (method === "OPTIONS") { res.writeHead(204); res.end(); return; }

  // ── GET /health ────────────────────────────────────────────────────────
  if (method === "GET" && path === "/health") {
    jsonRes(res, 200, {
      ready: true,
      version: VERSION,
      uptimeMs: Date.now() - _startedAt.getTime(),
      pid: process.pid,
    });
    return;
  }

  // ── GET /status ────────────────────────────────────────────────────────
  if (method === "GET" && path === "/status") {
    jsonRes(res, 200, buildStatus());
    return;
  }

  // ── GET /events (SSE) ──────────────────────────────────────────────────
  if (method === "GET" && path === "/events") {
    const since = url.searchParams.get("since");
    const replay = since ? _ring.filter((e) => e.ts > since) : [];

    res.writeHead(200, {
      "Content-Type": "text/event-stream",
      "Cache-Control": "no-cache",
      "Connection": "keep-alive",
      "Access-Control-Allow-Origin": "*",
    });

    // Initial comment confirms the connection and unblocks streaming clients
    res.write(": ping\n\n");

    for (const ev of replay) res.write(`data: ${JSON.stringify(ev)}\n\n`);

    const id = ++_sseSeq;
    _sseClients.set(id, res);
    req.on("close", () => _sseClients.delete(id));
    return; // keep connection open
  }

  // ── GET /projects ──────────────────────────────────────────────────────
  if (method === "GET" && path === "/projects") {
    const projects = listProjects().map((p) => {
      const codeSource = p.sources.find((s) => s.source_config.type === "code");
      let rootPath = "";
      if (codeSource && codeSource.source_config.type === "code") {
        rootPath = (codeSource.source_config as { type: "code"; root_path: string }).root_path;
      }
      return {
        id: p.id,
        rootPath,
        branches: codeSource?.pinned_branches ?? [],
        lastIndexed: codeSource?.last_indexed ?? null,
        watcherHealthy: false,
      };
    });
    jsonRes(res, 200, { projects });
    return;
  }

  // ── POST /kick ─────────────────────────────────────────────────────────
  if (method === "POST" && path === "/kick") {
    const body = (await readBody(req)) as KickRequest;
    const result = _onKick ? await _onKick(body) : { jobs: [] };
    jsonRes(res, 200, result);
    return;
  }

  // ── POST /pause ────────────────────────────────────────────────────────
  if (method === "POST" && path === "/pause") {
    _state = "paused";
    jsonRes(res, 200, { state: "paused" });
    return;
  }

  // ── POST /resume ───────────────────────────────────────────────────────
  if (method === "POST" && path === "/resume") {
    _state = "hot";
    jsonRes(res, 200, { state: "hot" });
    return;
  }

  // ── POST /shutdown ─────────────────────────────────────────────────────
  if (method === "POST" && path === "/shutdown") {
    jsonRes(res, 200, { state: "stopping" });
    setImmediate(() => _onShutdown?.());
    return;
  }

  // ── POST /clients/heartbeat ────────────────────────────────────────────
  if (method === "POST" && path === "/clients/heartbeat") {
    const body = (await readBody(req)) as { clientId?: string; pid?: number };
    if (body.clientId) _onHeartbeat?.(body.clientId, body.pid ?? 0);
    jsonRes(res, 200, { ok: true });
    return;
  }

  // ── POST /clients/unregister ───────────────────────────────────────────
  if (method === "POST" && path === "/clients/unregister") {
    const body = (await readBody(req)) as { clientId?: string };
    if (body.clientId) _onUnregister?.(body.clientId);
    jsonRes(res, 200, { ok: true });
    return;
  }

  // ── Pinned-branches CRUD ───────────────────────────────────────────────
  const pinnedMatch = PINNED_RE.exec(path);
  if (pinnedMatch) {
    const projectId = decodeURIComponent(pinnedMatch[1]);
    const sourceId = decodeURIComponent(pinnedMatch[2]);

    try {
      if (method === "GET") {
        jsonRes(res, 200, { branches: listPinned(projectId, sourceId) });
        return;
      }

      if (method === "POST") {
        const body = (await readBody(req)) as { branches?: string[]; mode?: "add" | "set" };
        const result = addPinned(projectId, sourceId, body.branches ?? [], body.mode);
        pushEvent({
          ts: new Date().toISOString(), level: "info", event: "pinned.changed",
          projectId, sourceId, detail: { action: "add", branches: result.added },
        });
        jsonRes(res, 200, result);
        return;
      }

      if (method === "DELETE") {
        let result: { branches: string[]; removed: string[] };
        if (url.searchParams.get("all") === "true") {
          result = clearPinned(projectId, sourceId);
        } else {
          const body = (await readBody(req)) as { branches?: string[] };
          result = removePinned(projectId, sourceId, body.branches ?? []);
        }
        pushEvent({
          ts: new Date().toISOString(), level: "info", event: "pinned.changed",
          projectId, sourceId, detail: { action: "remove", branches: result.removed },
        });
        jsonRes(res, 200, result);
        return;
      }
    } catch (e) {
      if (e instanceof InvalidSourceTypeError) {
        jsonRes(res, 400, { error: e.message, error_type: "invalid_source_type" });
        return;
      }
      if (e instanceof ProjectNotFoundError) {
        jsonRes(res, 404, { error: e.message, error_type: "project_not_found" });
        return;
      }
      if (e instanceof SourceNotFoundError) {
        jsonRes(res, 404, { error: e.message, error_type: "source_not_found" });
        return;
      }
      throw e;
    }
  }

  jsonRes(res, 404, { error: "Not found" });
}
