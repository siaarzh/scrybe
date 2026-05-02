/**
 * DaemonClient — typed HTTP client for the scrybe daemon.
 * Contract 15: imported by M-D3 VS Code extension and test helpers.
 */
import { readPidfile } from "./pidfile.js";
import { spawnDaemonDetached } from "./spawn-detached.js";
import { isContainer } from "./container-detect.js";
import { VERSION } from "../config.js";
import type {
  DaemonStatus, DaemonEvent, KickRequest, KickResponse, GcRequest, GcResponse,
} from "./http-server.js";

export type { DaemonStatus, DaemonEvent, KickRequest, KickResponse, GcRequest, GcResponse };

export type EnsureRunningResult =
  | { ok: true }
  | { ok: false; reason: "container" | "opted-out" | "spawn-failed" | "health-timeout" };

const DAEMON_OPT_OUT_ENV = "SCRYBE_NO_AUTO_DAEMON";

/**
 * Fix 3 (Plan 31): Warn once per CLI process when the running daemon's version
 * differs from the CLI version. Printed to stderr; suppressed on --json paths
 * via the SCRYBE_JSON_OUTPUT env var (set by CLI before calling daemon tools).
 * Never throws.
 *
 * Exported as warnVersionSkewCli so cli.ts can call it once at startup for
 * every command (not just daemon-routing ones).
 */
let _skewWarned = false;
export function warnVersionSkewCli(daemonVersion: string): void {
  if (_skewWarned) return;
  if (process.env["SCRYBE_JSON_OUTPUT"] === "1") return;
  if (!daemonVersion || daemonVersion === VERSION) return;
  _skewWarned = true;
  process.stderr.write(
    `[scrybe] daemon is running v${daemonVersion} but CLI is v${VERSION}.\n` +
    `[scrybe] Restart to pick up new code: scrybe daemon stop  (auto-respawns on next call)\n`
  );
}

/**
 * Ensure the daemon is running, starting it if needed.
 *
 * Returns { ok: true } when the daemon is reachable.
 * Returns { ok: false, reason } for the two in-process opt-out paths (container/opted-out)
 * or for genuine spawn failures.
 *
 * Callers should use in-process indexing for "container" and "opted-out", and surface the
 * diagnostic message for "spawn-failed" and "health-timeout".
 */
export async function ensureRunning(timeoutMs = 3000): Promise<EnsureRunningResult> {
  // Explicit opt-out
  if (process.env[DAEMON_OPT_OUT_ENV] === "1") {
    return { ok: false, reason: "opted-out" };
  }
  // Container environments: Docker, Kubernetes, WSL2 — in-process only
  if (isContainer()) {
    return { ok: false, reason: "container" };
  }

  const existingPid = readPidfile();
  if (existingPid?.version) warnVersionSkewCli(existingPid.version);
  const existing = existingPid?.port ? new DaemonClient({ port: existingPid.port }) : null;
  if (existing) {
    try {
      await existing.health();
      return { ok: true };
    } catch {
      // Stale pidfile — proceed to spawn
    }
  }

  // Spawn daemon and wait for it to become healthy
  try {
    spawnDaemonDetached({});
  } catch {
    return { ok: false, reason: "spawn-failed" };
  }

  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const client = DaemonClient.fromPidfile();
    if (client) {
      try {
        await client.health();
        return { ok: true };
      } catch { /* not ready yet */ }
    }
    await new Promise((r) => setTimeout(r, 100));
  }

  return { ok: false, reason: "health-timeout" };
}

export class DaemonClient {
  private readonly _baseUrl: string;
  private _ac: AbortController | null = null;

  constructor(opts: { port?: number; dataDir?: string; baseUrl?: string } = {}) {
    if (opts.baseUrl) {
      this._baseUrl = opts.baseUrl.replace(/\/$/, "");
    } else {
      this._baseUrl = `http://127.0.0.1:${opts.port ?? 58451}`;
    }
  }

  static fromPidfile(_dataDir?: string): DaemonClient | null {
    const data = readPidfile();
    if (!data?.port) return null;
    if (data.version) warnVersionSkewCli(data.version);
    return new DaemonClient({ port: data.port });
  }

  async health(): Promise<{ ready: boolean; version: string; uptimeMs: number; pid: number }> {
    return this._get("/health");
  }

  async status(): Promise<DaemonStatus> {
    return this._get("/status");
  }

  async kick(req: KickRequest): Promise<KickResponse> {
    return this._post("/kick", req);
  }

  /** Submit a reindex request. Returns immediately with job_id + queue status. */
  async submitReindex(req: KickRequest): Promise<KickResponse> {
    return this._post("/kick", req);
  }

  /**
   * Submit a manual gc request. Daemon will atomically:
   *   1. Cancel pending auto-gc jobs in scope
   *   2. Reset per-project idle timers for scope
   *   3. Enqueue user-gc jobs (default mode: "purge" for full reclaim)
   * Returns the count of pending auto-gc jobs cancelled and the new user-gc job IDs.
   */
  async submitGc(req: GcRequest = {}): Promise<GcResponse> {
    return this._post("/gc", req);
  }

  /** Get status of a specific job from the daemon's SQLite store. */
  async jobStatus(jobId: string): Promise<unknown> {
    return this._get(`/jobs/${encodeURIComponent(jobId)}`);
  }

  /** List jobs, optionally filtered. */
  async listJobs(opts: { status?: string; projectId?: string } = {}): Promise<unknown> {
    const params = new URLSearchParams();
    if (opts.status) params.set("status", opts.status);
    if (opts.projectId) params.set("project_id", opts.projectId);
    const qs = params.toString();
    return this._get(`/jobs${qs ? `?${qs}` : ""}`);
  }

  /** Get running + queued jobs for a project (or all projects). */
  async queueStatus(projectId?: string): Promise<{ running: unknown[]; queued: unknown[] }> {
    const qs = projectId ? `?project_id=${encodeURIComponent(projectId)}` : "";
    return this._get(`/queue-status${qs}`);
  }

  /** Cancel a running or queued job. */
  async cancelJob(jobId: string): Promise<{ cancelled: boolean }> {
    return this._delete(`/jobs/${encodeURIComponent(jobId)}`);
  }

  async pause(): Promise<{ state: string }> {
    return this._post("/pause");
  }

  async resume(): Promise<{ state: string }> {
    return this._post("/resume");
  }

  async shutdown(): Promise<{ state: string }> {
    return this._post("/shutdown");
  }

  async projects(): Promise<Array<{
    id: string;
    rootPath: string;
    branches: string[];
    lastIndexed: string | null;
    watcherHealthy: boolean;
  }>> {
    const data = await this._get<{ projects: unknown[] }>("/projects");
    return data.projects as ReturnType<DaemonClient["projects"]> extends Promise<infer T> ? T : never;
  }

  /** SSE consumer — yields DaemonEvent objects until the connection drops or close() is called. */
  async *watchEvents(since?: string): AsyncIterable<DaemonEvent> {
    const url = new URL(`${this._baseUrl}/events`);
    if (since) url.searchParams.set("since", since);

    this._ac = new AbortController();
    let res: Response;
    try {
      res = await fetch(url.toString(), {
        signal: this._ac.signal,
        headers: { Accept: "text/event-stream" },
      });
    } catch {
      return;
    }

    if (!res.ok || !res.body) return;

    const decoder = new TextDecoder();
    let buffer = "";

    try {
      for await (const raw of res.body as unknown as AsyncIterable<Uint8Array>) {
        buffer += decoder.decode(raw, { stream: true });
        let pos: number;
        while ((pos = buffer.indexOf("\n\n")) !== -1) {
          const line = buffer.slice(0, pos);
          buffer = buffer.slice(pos + 2);
          if (line.startsWith("data: ")) {
            try {
              yield JSON.parse(line.slice(6)) as DaemonEvent;
            } catch { /* ignore malformed */ }
          }
        }
      }
    } catch {
      // Aborted or connection closed — normal exit
    }
  }

  close(): void {
    this._ac?.abort();
    this._ac = null;
  }

  private async _get<T = unknown>(path: string): Promise<T> {
    const res = await fetch(`${this._baseUrl}${path}`);
    if (!res.ok) throw new Error(`GET ${path} returned ${res.status}`);
    return res.json() as Promise<T>;
  }

  private async _post<T = unknown>(path: string, body?: unknown): Promise<T> {
    const res = await fetch(`${this._baseUrl}${path}`, {
      method: "POST",
      headers: body != null ? { "Content-Type": "application/json" } : {},
      body: body != null ? JSON.stringify(body) : undefined,
    });
    if (!res.ok) throw new Error(`POST ${path} returned ${res.status}`);
    return res.json() as Promise<T>;
  }

  private async _delete<T = unknown>(path: string): Promise<T> {
    const res = await fetch(`${this._baseUrl}${path}`, { method: "DELETE" });
    if (!res.ok) throw new Error(`DELETE ${path} returned ${res.status}`);
    return res.json() as Promise<T>;
  }
}
