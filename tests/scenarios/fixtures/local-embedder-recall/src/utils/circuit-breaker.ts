/**
 * Circuit breaker pattern for protecting downstream services.
 * Prevents cascading failures by short-circuiting repeated calls to failing endpoints.
 *
 * States:
 *   CLOSED  — normal operation; failures accumulate
 *   OPEN    — tripped; all calls fail immediately (no downstream call)
 *   HALF_OPEN — probe state; one test call allowed; resets to CLOSED on success
 */

export type CircuitState = "CLOSED" | "OPEN" | "HALF_OPEN";

export interface CircuitBreakerConfig {
  failureThreshold: number;   // open circuit after this many consecutive failures
  successThreshold: number;   // close circuit after this many consecutive successes in half-open
  halfOpenTimeoutMs: number;  // how long to wait in OPEN before attempting HALF_OPEN
}

const DEFAULT_CONFIG: CircuitBreakerConfig = {
  failureThreshold: 5,
  successThreshold: 2,
  halfOpenTimeoutMs: 30_000,
};

export class CircuitBreaker {
  private state: CircuitState = "CLOSED";
  private failureCount = 0;
  private successCount = 0;
  private openedAt: number | null = null;

  constructor(
    private readonly name: string,
    private readonly config: CircuitBreakerConfig = DEFAULT_CONFIG
  ) {}

  get currentState(): CircuitState { return this.state; }

  /**
   * Execute a protected operation through the circuit breaker.
   * Throws immediately if OPEN; re-throws on operation failure.
   */
  async execute<T>(operation: () => Promise<T>): Promise<T> {
    if (this.state === "OPEN") {
      if (this.openedAt && Date.now() - this.openedAt >= this.config.halfOpenTimeoutMs) {
        this.state = "HALF_OPEN";
        this.successCount = 0;
      } else {
        throw new Error(`Circuit breaker '${this.name}' is OPEN — downstream calls blocked`);
      }
    }

    try {
      const result = await operation();
      this.onSuccess();
      return result;
    } catch (err) {
      this.onFailure();
      throw err;
    }
  }

  private onSuccess(): void {
    this.failureCount = 0;
    if (this.state === "HALF_OPEN") {
      this.successCount++;
      if (this.successCount >= this.config.successThreshold) {
        this.state = "CLOSED";
        this.openedAt = null;
      }
    }
  }

  private onFailure(): void {
    this.failureCount++;
    if (this.state === "HALF_OPEN" || this.failureCount >= this.config.failureThreshold) {
      this.state = "OPEN";
      this.openedAt = Date.now();
      this.failureCount = 0;
    }
  }

  /** Manually reset the circuit to CLOSED (for admin/test use). */
  reset(): void {
    this.state = "CLOSED";
    this.failureCount = 0;
    this.successCount = 0;
    this.openedAt = null;
  }
}
