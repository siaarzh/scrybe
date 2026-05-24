/**
 * Generic retry utility with configurable backoff strategies.
 * Supports exponential backoff, jitter, and error-class filtering.
 */

export type BackoffStrategy = "exponential" | "linear" | "constant";

export interface RetryOptions {
  maxAttempts: number;
  strategy: BackoffStrategy;
  baseDelayMs: number;
  maxDelayMs?: number;
  jitter?: boolean;
  shouldRetry?: (error: unknown, attempt: number) => boolean;
  onRetry?: (error: unknown, attempt: number, delayMs: number) => void;
}

const DEFAULT_OPTS: RetryOptions = {
  maxAttempts: 3,
  strategy: "exponential",
  baseDelayMs: 500,
  maxDelayMs: 30_000,
  jitter: true,
};

/** Compute the delay for a given attempt and strategy. */
export function computeDelay(attempt: number, opts: RetryOptions): number {
  let delay: number;
  switch (opts.strategy) {
    case "exponential":
      delay = opts.baseDelayMs * Math.pow(2, attempt - 1);
      break;
    case "linear":
      delay = opts.baseDelayMs * attempt;
      break;
    case "constant":
    default:
      delay = opts.baseDelayMs;
  }

  if (opts.maxDelayMs != null) delay = Math.min(delay, opts.maxDelayMs);
  if (opts.jitter) delay = delay * (0.5 + Math.random() * 0.5);

  return Math.ceil(delay);
}

/**
 * Retry an async operation with configurable backoff.
 * Throws the last error if all attempts are exhausted.
 */
export async function withRetry<T>(
  operation: (attempt: number) => Promise<T>,
  opts: Partial<RetryOptions> = {}
): Promise<T> {
  const config = { ...DEFAULT_OPTS, ...opts };

  for (let attempt = 1; attempt <= config.maxAttempts; attempt++) {
    try {
      return await operation(attempt);
    } catch (err) {
      const isLast = attempt === config.maxAttempts;
      const shouldRetry = config.shouldRetry?.(err, attempt) ?? true;

      if (isLast || !shouldRetry) throw err;

      const delayMs = computeDelay(attempt, config);
      config.onRetry?.(err, attempt, delayMs);
      await new Promise((r) => setTimeout(r, delayMs));
    }
  }

  /* istanbul ignore next */
  throw new Error("withRetry: exhausted attempts");
}

/** Retry only on specific HTTP status codes. */
export function retryOnStatus(...codes: number[]): RetryOptions["shouldRetry"] {
  return (err) => {
    const status = (err as { status?: number })?.status ?? 0;
    return codes.includes(status);
  };
}
