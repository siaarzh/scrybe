/**
 * Structured JSON logger with log levels and child logger support.
 * Outputs one newline-delimited JSON record per log call.
 */

export type LogLevel = "debug" | "info" | "warn" | "error";

const LEVELS: Record<LogLevel, number> = { debug: 0, info: 1, warn: 2, error: 3 };

export interface LogRecord {
  ts: string;
  level: LogLevel;
  msg: string;
  [key: string]: unknown;
}

export interface Logger {
  debug(msg: string, extra?: Record<string, unknown>): void;
  info(msg: string, extra?: Record<string, unknown>): void;
  warn(msg: string, extra?: Record<string, unknown>): void;
  error(msg: string, extra?: Record<string, unknown>): void;
  child(bindings: Record<string, unknown>): Logger;
}

/**
 * Create a structured logger.
 * @param minLevel - minimum level to emit (defaults to "info")
 * @param bindings - fields merged into every log record
 */
export function createLogger(
  minLevel: LogLevel = "info",
  bindings: Record<string, unknown> = {}
): Logger {
  const minN = LEVELS[minLevel];

  function emit(level: LogLevel, msg: string, extra: Record<string, unknown> = {}) {
    if (LEVELS[level] < minN) return;
    const record: LogRecord = {
      ts: new Date().toISOString(),
      level,
      msg,
      ...bindings,
      ...extra,
    };
    process.stdout.write(JSON.stringify(record) + "\n");
  }

  return {
    debug: (msg, extra) => emit("debug", msg, extra),
    info: (msg, extra) => emit("info", msg, extra),
    warn: (msg, extra) => emit("warn", msg, extra),
    error: (msg, extra) => emit("error", msg, extra),
    child: (extraBindings) => createLogger(minLevel, { ...bindings, ...extraBindings }),
  };
}

/** Module-level default logger. Replace with createLogger in tests. */
export const logger = createLogger(
  (process.env.LOG_LEVEL as LogLevel | undefined) ?? "info",
  { service: process.env.SERVICE_NAME ?? "app" }
);
