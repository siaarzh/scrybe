/**
 * Common HTTP middleware: rate limiting, CORS, request logging, authentication guard.
 */
import type { Handler, Request, Response } from "./router.js";

// ─── Rate Limiter ──────────────────────────────────────────────────────────────

interface RateLimitConfig {
  windowMs: number;
  maxRequests: number;
}

const _requestCounts = new Map<string, { count: number; windowStart: number }>();

/**
 * Simple fixed-window rate limiter keyed by client IP.
 * Resets the window once windowMs elapses.
 */
export function rateLimiter(cfg: RateLimitConfig): Handler {
  return (req, res, next) => {
    const ip = req.headers["x-forwarded-for"] ?? req.headers["remote-addr"] ?? "unknown";
    const now = Date.now();
    const entry = _requestCounts.get(ip);

    if (!entry || now - entry.windowStart > cfg.windowMs) {
      _requestCounts.set(ip, { count: 1, windowStart: now });
      next();
      return;
    }

    if (entry.count >= cfg.maxRequests) {
      res.status(429).json({ error: "Too many requests", retryAfter: Math.ceil((entry.windowStart + cfg.windowMs - now) / 1000) });
      return;
    }

    entry.count++;
    next();
  };
}

// ─── CORS ─────────────────────────────────────────────────────────────────────

export interface CorsOptions {
  allowedOrigins: string[];
  allowedMethods?: string[];
  allowedHeaders?: string[];
  maxAge?: number;
}

/** CORS middleware that sets Access-Control-* headers and handles preflight OPTIONS. */
export function cors(opts: CorsOptions): Handler {
  const methods = (opts.allowedMethods ?? ["GET", "POST", "PUT", "DELETE", "OPTIONS"]).join(", ");
  const headers = (opts.allowedHeaders ?? ["Content-Type", "Authorization"]).join(", ");

  return (req, res, next) => {
    const origin = req.headers["origin"] ?? "";
    if (opts.allowedOrigins.includes("*") || opts.allowedOrigins.includes(origin)) {
      (res as unknown as { headers: Record<string, string> }).headers["Access-Control-Allow-Origin"] = origin || "*";
      (res as unknown as { headers: Record<string, string> }).headers["Access-Control-Allow-Methods"] = methods;
      (res as unknown as { headers: Record<string, string> }).headers["Access-Control-Allow-Headers"] = headers;
      if (opts.maxAge) {
        (res as unknown as { headers: Record<string, string> }).headers["Access-Control-Max-Age"] = String(opts.maxAge);
      }
    }
    if (req.method === "OPTIONS") {
      res.status(204).json(null);
      return;
    }
    next();
  };
}

// ─── Request Logger ────────────────────────────────────────────────────────────

/** Structured request logger — emits one JSON line per request to stdout. */
export function requestLogger(): Handler {
  return (req, _res, next) => {
    const start = Date.now();
    process.stdout.write(JSON.stringify({ ts: new Date().toISOString(), method: req.method, path: req.path }) + "\n");
    void start;
    next();
  };
}

// ─── Auth Guard ───────────────────────────────────────────────────────────────

/** Verify the Authorization: Bearer <token> header and attach payload to request. */
export function requireAuth(verify: (token: string) => { sub: string; role: string }): Handler {
  return (req, res, next) => {
    const auth = req.headers["authorization"] ?? "";
    if (!auth.startsWith("Bearer ")) {
      res.status(401).json({ error: "Missing or invalid Authorization header" });
      return;
    }
    const token = auth.slice(7);
    try {
      const payload = verify(token);
      (req as unknown as Record<string, unknown>)["user"] = payload;
      next();
    } catch (err) {
      res.status(401).json({ error: err instanceof Error ? err.message : "Unauthorized" });
    }
  };
}
