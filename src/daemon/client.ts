/**
 * DaemonClient — typed HTTP client for the scrybe daemon.
 * Contract 15: imported by M-D3 VS Code extension and test helpers.
 */
import { readPidfile } from "./pidfile.js";
import { spawnDaemonDetachedAsync } from "./spawn-detached.js";
import { isContainer } from "./container-detect.js";
import { acquireSpawnLock, releaseSpawnLock } from "./data-dir-lock.js";
import { diagEmit } from "./events.js";
import { VERSION } from "../config.js";
import type {
  DaemonStatus, DaemonEvent, KickRequest, KickResponse, GcRequest, GcResponse,
} from "./http-server.js";

export type { DaemonStatus, DaemonEvent, KickRequest, KickResponse, GcRequest, GcResponse };

export type EnsureRunningResult =
  | {
      ok: true;
      /**
       * The daemon answered, but it is DRAINING — finishing in-flight work
       * before it exits (review G4). Deliberately still `ok: true`: the drain
       * gate keeps reads and `/mcp/rpc` search serving against a still-open DB
       * (review G1), so failing every caller here would recreate the outage
       * G1 exists to remove. Only callers that want to ENQUEUE work
       * (reindex/gc/source) need to treat this as degraded and fall back
       * in-process — the daemon will refuse those with 503.
       */
      draining?: boolean;
    }
  | { ok: false; reason: "container" | "opted-out" | "spawn-failed" | "health-timeout" };

const DAEMON_OPT_OUT_ENV = "SCRYBE_NO_AUTO_DAEMON";

/**
 * Cold-start budget for "make sure a daemon exists and is healthy".
 *
 * One constant shared by every caller that needs a *verified* daemon — the MCP
 * shim's cold start and `daemon up` (review G13, which otherwise grew its own
 * hard-coded 20 s). `ensureRunning()`'s own default (3 s) stays as-is for
 * opportunistic callers that can degrade.
 */
export const DAEMON_COLD_START_WAIT_MS = 15_000;

/**
 * The error a WRITE path must surface for a degraded `ensureRunning()` outcome,
 * or `null` when the caller may proceed (either through the daemon or, for
 * `container`/`opted-out`, in-process — there is no daemon by design there).
 *
 * Review G4: `draining` is included. The daemon refuses new work with 503 while
 * draining, and callers could not tell — they issued the request, got a raw
 * `HTTP 503` and, because the in-process fallback was gated on the two `ok:false`
 * reasons, `scrybe index` exited 1 with a bare HTTP error. Falling back
 * in-process is not the answer either: it would put a SECOND writer on a
 * LanceDB dir the draining daemon still owns. Refuse, and say to retry.
 *
 * Consolidated here because the same block was copy-pasted across four reindex
 * tools plus `source_add`.
 */
export function daemonWriteUnavailableError(
  result: EnsureRunningResult,
  what = "Reindex",
): (Error & { error_type: string }) | null {
  if (result.ok) {
    if (!result.draining) return null;
    return Object.assign(new Error(
      "The scrybe daemon is shutting down (finishing in-flight work) and is not accepting new jobs.\n" +
      "Retry in a moment — a replacement daemon starts on the next call."
    ), { error_type: "daemon_unavailable" });
  }
  if (result.reason === "spawn-failed" || result.reason === "health-timeout") {
    return Object.assign(new Error(
      `The scrybe daemon failed to start. ${what} requires the daemon to coordinate writes.\n` +
      "Diagnose: scrybe doctor  |  Single-shot: SCRYBE_NO_AUTO_DAEMON=1 scrybe index ..."
    ), { error_type: "daemon_unavailable" });
  }
  return null;
}

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
  const deadline = Date.now() + timeoutMs;

  if (existing) {
    try {
      const h = await existing.health();
      if (!h.draining) return { ok: true };
      // DRAINING — do not return yet. `waitForHealthyPidfile` exists precisely
      // for this case (see its docstring: a draining daemon must not end the
      // wait early, because it is on its way out and a replacement is usually
      // coming), but returning here meant the single most common shape —
      // pidfile intact, daemon alive and draining — was the one shape that
      // never reached it, and the caller spent none of its budget.
      //
      // The concrete cost of returning early: an always-on daemon's rss-guard
      // restart drains for ~2 s and DOES spawn its own replacement, yet a
      // caller with a 3-15 s budget was told "shutting down, retry later"; and
      // `daemon up` / the onboarding wizard read `ok: true` and reported a
      // daemon as started when the pid they printed was already exiting.
      //
      // A long drain (a plain `daemon stop`, up to 30 min, no replacement owed)
      // still ends in `{ok:true, draining:true}` — just after the caller's own
      // budget rather than instantly. That is the honest answer either way.
      //
      // "No caller waits longer than the timeout it chose" is an invariant this
      // function has to actively maintain, not a property it gets for free. Every
      // wait below is bounded by `deadline` — including the one thing that is not
      // a /health poll: the `systemd-run` cgroup wrapper inside
      // `spawnDaemonDetachedAsync`, which is handed the REMAINING budget and
      // allowed only a fraction of it (see `resolveWrapperTimeoutMs`). Left
      // unbounded it took a flat 10 s, which on a wedged user bus overran a 5 s
      // caller twice over and left `waitForHealthyPidfile` with an already-expired
      // deadline — reporting `health-timeout` for a daemon the fallback had
      // successfully started.
      return await waitForHealthyPidfile(deadline);
    } catch {
      // Stale pidfile — proceed to spawn
    }
  }

  // Plan 108 slice 2: serialise check→spawn across PROCESSES via the spawn
  // lock (client.ts is invoked as N separate OS processes — pmux sessions,
  // CLI invocations, the MCP shim — not N calls within one process, which is
  // exactly the shape of the incident). Only the caller that wins the lock
  // actually spawns a daemon; losers wait for the winner's daemon to become
  // healthy instead of racing a second spawn of their own. A crashed holder
  // cannot wedge a caller here: the lock is an open SQLite transaction, which
  // the OS drops when the holder dies — there is no reclaim step, no dead-pid
  // detection and no age expiry, because there is nothing left to reclaim.
  const lock = acquireSpawnLock();

  if (lock.outcome === "contended") {
    // Someone else is actively spawning right now — wait for THEIR daemon
    // within our existing timeout budget rather than spawning a second one.
    //
    // Review F16: emit the outcome. A `health-timeout` returned from HERE means
    // "we never even attempted a spawn because someone else held the lock",
    // which is a completely different incident from "we spawned and it never
    // came up" — and the whole class of bug this change addresses was
    // originally diagnosed from `daemon-log.jsonl`, so the distinction has to
    // be on record there.
    diagEmit({
      level: "warn",
      event: "daemon.spawn.contended",
      heldByPid: lock.heldByPid ?? null,
      timeoutMs,
    });
    return await waitForHealthyPidfile(deadline);
  }

  if (lock.outcome === "unavailable") {
    diagEmit({
      level: "warn",
      event: "daemon.spawn.lock_unavailable",
      errorCode: lock.error?.code ?? null,
      errorMessage: lock.error?.message ?? null,
    });
  }

  // "acquired", or "unavailable" (fail-open — a permissions/disk fault on the
  // lock must not block startup, only lose the serialisation guarantee for
  // this one call; matches the ownership lock's fail-open policy in
  // runDaemon()).
  try {
    // Re-check: the previous holder may have finished spawning between our
    // pidfile read above and winning the lock just now.
    const freshClient = DaemonClient.fromPidfile();
    if (freshClient) {
      try {
        const h = await freshClient.health();
        return h.draining ? { ok: true, draining: true } : { ok: true };
      } catch { /* still not healthy — proceed to spawn */ }
    }

    try {
      // Async variant on purpose. This caller has an event loop worth
      // protecting — the MCP shim reaches here mid-session with other RPCs in
      // flight — whereas the daemon's own restart sites call the sync form
      // because they `process.exit()` on the next line. `budgetMs` is what is
      // LEFT of the caller's deadline, not the original timeout: the pidfile
      // read, the /health probe above and the spawn-lock acquisition have all
      // already spent some of it.
      await spawnDaemonDetachedAsync({ budgetMs: Math.max(0, deadline - Date.now()) });
    } catch {
      return { ok: false, reason: "spawn-failed" };
    }

    return await waitForHealthyPidfile(deadline);
  } finally {
    if (lock.outcome === "acquired") releaseSpawnLock();
  }
}

/**
 * Poll the pidfile until it reports a healthy daemon or `deadline` passes.
 *
 * A DRAINING daemon does not end the wait early (review G4): it is on its way
 * out, so we keep polling for its replacement and only report `draining` if the
 * budget runs out first. That way the common case — a daemon shutting down
 * while a caller starts up — resolves to a fresh, fully-serving daemon.
 *
 * ALWAYS PROBES AT LEAST ONCE, even on an already-expired deadline (hence
 * do/while, not while). `health-timeout` is a claim about a daemon that did not
 * answer, and this function is the only thing entitled to make it; returning it
 * without having asked turns any upstream overrun — a slow spawn, a scheduler
 * stall, a caller that passed a tiny timeout — into a false report about a
 * daemon that may well be serving. One extra probe costs a loopback round-trip
 * against a pidfile that usually does not exist yet.
 */
async function waitForHealthyPidfile(deadline: number): Promise<EnsureRunningResult> {
  let sawDraining = false;
  do {
    const client = DaemonClient.fromPidfile();
    if (client) {
      try {
        const h = await client.health();
        if (!h.draining) return { ok: true };
        sawDraining = true;
      } catch { /* not ready yet */ }
    }
    if (Date.now() >= deadline) break;
    await new Promise((r) => setTimeout(r, 100));
  } while (Date.now() < deadline);
  return sawDraining ? { ok: true, draining: true } : { ok: false, reason: "health-timeout" };
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

  /**
   * `draining` (review G15) is part of the typed contract, not a raw cast:
   * `doctor.ts` and the VS Code extension both read it, and it is the only way
   * a consumer can tell a serving daemon from one that is on its way out.
   */
  async health(): Promise<{ ready: boolean; version: string; uptimeMs: number; pid: number; draining?: boolean }> {
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
  async queueStatus(projectId?: string): Promise<{ running: unknown[]; queued: unknown[]; awaiting_migration?: unknown[] }> {
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
