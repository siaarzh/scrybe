/**
 * Server-side session store using an in-memory map with TTL eviction.
 * Suitable for single-node deployments; swap for Redis adapter on clusters.
 */

export interface Session {
  sessionId: string;
  userId: string;
  role: string;
  createdAt: number;
  lastActiveAt: number;
  expiresAt: number;
  metadata: Record<string, unknown>;
}

const SESSION_TTL_MS = 30 * 60 * 1000; // 30 minutes idle timeout

const _sessions = new Map<string, Session>();

/** Create a new session for the given user. Returns the session ID. */
export function createSession(userId: string, role: string, meta: Record<string, unknown> = {}): string {
  const sessionId = Math.random().toString(36).slice(2) + Date.now().toString(36);
  const now = Date.now();
  _sessions.set(sessionId, {
    sessionId,
    userId,
    role,
    createdAt: now,
    lastActiveAt: now,
    expiresAt: now + SESSION_TTL_MS,
    metadata: meta,
  });
  return sessionId;
}

/** Look up a session by ID. Returns null if not found or expired. */
export function getSession(sessionId: string): Session | null {
  const s = _sessions.get(sessionId);
  if (!s) return null;
  if (Date.now() > s.expiresAt) {
    _sessions.delete(sessionId);
    return null;
  }
  // Slide expiry window on each access
  s.lastActiveAt = Date.now();
  s.expiresAt = Date.now() + SESSION_TTL_MS;
  return s;
}

/** Invalidate a session (logout). */
export function destroySession(sessionId: string): void {
  _sessions.delete(sessionId);
}

/** Purge all expired sessions from the in-memory store. Call on a timer. */
export function sweepExpiredSessions(): number {
  const now = Date.now();
  let removed = 0;
  for (const [id, session] of _sessions) {
    if (now > session.expiresAt) {
      _sessions.delete(id);
      removed++;
    }
  }
  return removed;
}
