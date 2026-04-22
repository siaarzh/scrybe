/**
 * DaemonClient — typed HTTP client for the scrybe daemon.
 * Contract 15: imported by M-D3 VS Code extension and test helpers.
 */
import { readPidfile } from "./pidfile.js";
import type {
  DaemonStatus, DaemonEvent, KickRequest, KickResponse,
} from "./http-server.js";

export type { DaemonStatus, DaemonEvent, KickRequest, KickResponse };

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
}
