/**
 * Application error hierarchy.
 * Typed errors with HTTP status codes and machine-readable codes.
 */

export type ErrorCode =
  | "not_found"
  | "unauthorized"
  | "forbidden"
  | "validation_failed"
  | "conflict"
  | "rate_limited"
  | "internal_error"
  | "service_unavailable";

export interface AppErrorOptions {
  code: ErrorCode;
  message: string;
  httpStatus: number;
  details?: unknown;
  cause?: unknown;
}

/** Base application error — all domain errors extend this. */
export class AppError extends Error {
  readonly code: ErrorCode;
  readonly httpStatus: number;
  readonly details: unknown;

  constructor(opts: AppErrorOptions) {
    super(opts.message);
    this.name = "AppError";
    this.code = opts.code;
    this.httpStatus = opts.httpStatus;
    this.details = opts.details ?? null;
    if (opts.cause) {
      (this as { cause?: unknown }).cause = opts.cause;
    }
  }

  toJSON() {
    return {
      error: { code: this.code, message: this.message, details: this.details },
    };
  }
}

// ─── Specific error types ──────────────────────────────────────────────────────

export class NotFoundError extends AppError {
  constructor(resource: string, id?: string) {
    super({
      code: "not_found",
      message: id ? `${resource} with id '${id}' not found` : `${resource} not found`,
      httpStatus: 404,
    });
    this.name = "NotFoundError";
  }
}

export class UnauthorizedError extends AppError {
  constructor(reason = "Authentication required") {
    super({ code: "unauthorized", message: reason, httpStatus: 401 });
    this.name = "UnauthorizedError";
  }
}

export class ForbiddenError extends AppError {
  constructor(action?: string) {
    super({
      code: "forbidden",
      message: action ? `Forbidden: insufficient permissions to ${action}` : "Forbidden",
      httpStatus: 403,
    });
    this.name = "ForbiddenError";
  }
}

export class ValidationError extends AppError {
  constructor(details: unknown) {
    super({ code: "validation_failed", message: "Validation failed", httpStatus: 422, details });
    this.name = "ValidationError";
  }
}

export class ConflictError extends AppError {
  constructor(message: string) {
    super({ code: "conflict", message, httpStatus: 409 });
    this.name = "ConflictError";
  }
}

export class RateLimitError extends AppError {
  constructor(retryAfterSeconds: number) {
    super({
      code: "rate_limited",
      message: "Too many requests",
      httpStatus: 429,
      details: { retryAfterSeconds },
    });
    this.name = "RateLimitError";
  }
}

/** Type guard: check if an unknown thrown value is an AppError. */
export function isAppError(err: unknown): err is AppError {
  return err instanceof AppError;
}
