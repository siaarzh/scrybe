import { EventEmitter } from "events";

export interface ClientRegistration {
  clientId: string;
  pid: number;
  registeredAt: Date;
  lastHeartbeat: Date;
}

// Typed event overloads
export declare interface LifecycleManager {
  on(event: "shutdown", listener: (reason: "grace" | "no-client-ever") => void): this;
  emit(event: "shutdown", reason: "grace" | "no-client-ever"): boolean;
}

/**
 * Tracks MCP client heartbeats and drives the daemon lifetime state machine.
 *
 * State machine (when KEEP_ALIVE is unset):
 *   [waiting-for-first-client]
 *     → heartbeat received → cancel no-client-ever timer → [serving-clients]
 *     → no-client-ever timer fires → emit "shutdown"
 *   [serving-clients]
 *     → clients drop to 0 → start grace timer → [grace]
 *     → heartbeat re-arrives → cancel grace timer → [serving-clients]
 *   [grace]
 *     → grace timer fires → emit "shutdown"
 *     → heartbeat re-arrives → cancel grace timer → [serving-clients]
 *   [always-on] (KEEP_ALIVE=1): no timers, no shutdown events.
 */
export class LifecycleManager extends EventEmitter {
  private readonly keepAlive: boolean;
  private readonly heartbeatStaleMs: number;
  private readonly graceMs: number;
  private readonly noClientMs: number;

  private readonly clients = new Map<string, ClientRegistration>();
  private graceTimer: ReturnType<typeof setTimeout> | null = null;
  private graceStartedAt: number | null = null;
  private noClientTimer: ReturnType<typeof setTimeout> | null = null;
  private pruneInterval: ReturnType<typeof setInterval> | null = null;
  private hadClientEver = false;

  constructor() {
    super();
    this.keepAlive        = process.env["SCRYBE_DAEMON_KEEP_ALIVE"] === "1";
    this.heartbeatStaleMs = parseInt(process.env["SCRYBE_DAEMON_HEARTBEAT_STALE_MS"] ?? "60000", 10);
    this.graceMs          = parseInt(process.env["SCRYBE_DAEMON_IDLE_GRACE_MS"] ?? "600000", 10);
    this.noClientMs       = parseInt(process.env["SCRYBE_DAEMON_NO_CLIENT_TIMEOUT_MS"] ?? "900000", 10);
  }

  start(): void {
    if (this.keepAlive) return;

    this.noClientTimer = setTimeout(() => {
      if (!this.hadClientEver) this.emit("shutdown", "no-client-ever");
    }, this.noClientMs);
    this.noClientTimer.unref?.();

    this.pruneInterval = setInterval(() => this.pruneStaleClients(), 30_000);
    this.pruneInterval.unref?.();
  }

  registerOrUpdate(client: { clientId: string; pid: number }): void {
    const now = new Date();
    const existing = this.clients.get(client.clientId);
    if (existing) {
      existing.lastHeartbeat = now;
      existing.pid = client.pid;
    } else {
      this.clients.set(client.clientId, {
        clientId: client.clientId,
        pid: client.pid,
        registeredAt: now,
        lastHeartbeat: now,
      });
    }

    if (!this.hadClientEver) {
      this.hadClientEver = true;
      if (this.noClientTimer) {
        clearTimeout(this.noClientTimer);
        this.noClientTimer = null;
      }
    }

    // Cancel grace timer — a client is active
    if (this.graceTimer) {
      clearTimeout(this.graceTimer);
      this.graceTimer = null;
      this.graceStartedAt = null;
    }
  }

  unregister(clientId: string): void {
    this.clients.delete(clientId);
    this._checkEmpty();
  }

  pruneStaleClients(): void {
    const cutoff = Date.now() - this.heartbeatStaleMs;
    for (const [id, c] of this.clients) {
      if (c.lastHeartbeat.getTime() < cutoff) this.clients.delete(id);
    }
    this._checkEmpty();
  }

  getClients(): ClientRegistration[] {
    return [...this.clients.values()];
  }

  getClientCount(): number {
    return this.clients.size;
  }

  isAlwaysOn(): boolean {
    return this.keepAlive;
  }

  /** Returns ms remaining in the grace period, or null if not in grace. */
  gracePeriodRemainingMs(): number | null {
    if (!this.graceTimer || this.graceStartedAt === null) return null;
    return Math.max(0, this.graceMs - (Date.now() - this.graceStartedAt));
  }

  stop(): void {
    if (this.graceTimer) clearTimeout(this.graceTimer);
    if (this.noClientTimer) clearTimeout(this.noClientTimer);
    if (this.pruneInterval) clearInterval(this.pruneInterval);
    this.graceTimer = null;
    this.noClientTimer = null;
    this.pruneInterval = null;
  }

  private _checkEmpty(): void {
    if (this.keepAlive) return;
    if (this.clients.size === 0 && this.hadClientEver && !this.graceTimer) {
      this.graceStartedAt = Date.now();
      this.graceTimer = setTimeout(() => {
        this.graceTimer = null;
        this.graceStartedAt = null;
        if (this.clients.size === 0) this.emit("shutdown", "grace");
      }, this.graceMs);
      this.graceTimer.unref?.();
    }
  }
}
