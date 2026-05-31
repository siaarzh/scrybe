/**
 * Ticket poller unit tests — Plan 44, Slice 3.
 *
 * Strategy: mock the three boundary modules (queue, cursors, idle-state) so
 * tests are pure in-memory. `vi.useFakeTimers()` drives scheduling without
 * real waits. Each test clears mock call history in beforeEach.
 *
 * NOTE: The module's TICKET_ACTIVE_MS / TICKET_IDLE_MS / SKIP_TICKET_FETCH
 * constants are evaluated at import time. Because isolate.ts calls
 * vi.resetModules() in its own beforeEach, each dynamic `import()` inside a
 * test body gets a fresh module instance — env vars set before that import
 * are correctly picked up.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

// ─── Mocks (hoisted — declared once, call history cleared per test) ───────────

vi.mock("../src/daemon/queue.js", () => ({
  enqueue: vi.fn().mockResolvedValue("job-ticket"),
  initQueue: vi.fn(),
  getQueueStats: vi.fn().mockReturnValue({ active: 0, pending: 0, maxConcurrent: 1 }),
  stopQueue: vi.fn(),
}));

vi.mock("../src/cursors.js", () => ({
  loadCursor: vi.fn().mockReturnValue("2024-01-01T00:00:00Z"), // cursor present by default
  saveCursor: vi.fn(),
  deleteCursor: vi.fn(),
}));

vi.mock("../src/daemon/idle-state.js", () => ({
  getState: vi.fn().mockReturnValue("hot"),
  onStateChange: vi.fn(),
  touchActive: vi.fn(),
  getDebounceMs: vi.fn((ms: number) => ms),
  _resetForTests: vi.fn(),
}));

// Durable daemon-log writer — mocked so tests don't append to a real log file.
vi.mock("../src/daemon/events.js", () => ({
  diagEmit: vi.fn(),
}));

// ─── Helpers ─────────────────────────────────────────────────────────────────

/** Build a minimal ticket-source Project fixture. */
function makeProject(opts: {
  id?: string;
  sourceId?: string;
  baseUrl?: string;
}) {
  return {
    id: opts.id ?? "proj-1",
    description: "ticket test project",
    sources: [
      {
        source_id: opts.sourceId ?? "gl-issues",
        source_config: {
          type: "ticket" as const,
          provider: "gitlab",
          base_url: opts.baseUrl ?? "https://gitlab.example.com",
          project_id: "42",
          token: "tok",
        },
      },
    ],
  };
}

// ─── Tests ────────────────────────────────────────────────────────────────────

describe("ticket poller — SCRYBE_DAEMON_NO_TICKET_FETCH=1 disables poller", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    process.env["SCRYBE_DAEMON_NO_TICKET_FETCH"] = "1";
    vi.useFakeTimers();
  });

  afterEach(async () => {
    vi.useRealTimers();
    delete process.env["SCRYBE_DAEMON_NO_TICKET_FETCH"];
    try {
      const { stopTicketPoller } = await import("../src/daemon/ticket-poller.js");
      stopTicketPoller();
    } catch { /* ignore */ }
  });

  it("startTicketPoller is a no-op when NO_TICKET_FETCH=1", async () => {
    const { enqueue } = await import("../src/daemon/queue.js");
    const { initTicketPoller, startTicketPoller } = await import("../src/daemon/ticket-poller.js");

    initTicketPoller({ pushEvent: vi.fn() });
    startTicketPoller([makeProject({})]);

    await vi.runAllTimersAsync();

    expect(enqueue).not.toHaveBeenCalled();
  });

  it("ticketPollerOnHot is a no-op when NO_TICKET_FETCH=1", async () => {
    const { enqueue } = await import("../src/daemon/queue.js");
    const { initTicketPoller, startTicketPoller, ticketPollerOnHot } = await import(
      "../src/daemon/ticket-poller.js"
    );

    initTicketPoller({ pushEvent: vi.fn() });
    startTicketPoller([makeProject({})]);
    ticketPollerOnHot();

    await vi.runAllTimersAsync();

    expect(enqueue).not.toHaveBeenCalled();
  });
});

describe("ticket poller — interval selection: hot picks ACTIVE_MS", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    process.env["SCRYBE_DAEMON_TICKET_ACTIVE_MS"] = "1000";
    process.env["SCRYBE_DAEMON_TICKET_IDLE_MS"] = "5000";
    delete process.env["SCRYBE_DAEMON_NO_TICKET_FETCH"];
    vi.useFakeTimers();
  });

  afterEach(async () => {
    vi.useRealTimers();
    delete process.env["SCRYBE_DAEMON_TICKET_ACTIVE_MS"];
    delete process.env["SCRYBE_DAEMON_TICKET_IDLE_MS"];
    try {
      const { stopTicketPoller } = await import("../src/daemon/ticket-poller.js");
      stopTicketPoller();
    } catch { /* ignore */ }
  });

  it("schedules first poll at ACTIVE_MS when state=hot and cursor exists", async () => {
    const { enqueue } = await import("../src/daemon/queue.js");
    const { loadCursor } = await import("../src/cursors.js");
    vi.mocked(loadCursor).mockReturnValue("2024-01-01T00:00:00Z"); // cursor present

    const { getState } = await import("../src/daemon/idle-state.js");
    vi.mocked(getState).mockReturnValue("hot");

    const { initTicketPoller, startTicketPoller } = await import("../src/daemon/ticket-poller.js");
    initTicketPoller({ pushEvent: vi.fn() });
    startTicketPoller([makeProject({})]);

    // Should NOT have fired yet at t=0
    await vi.advanceTimersByTimeAsync(0);
    expect(enqueue).not.toHaveBeenCalled();

    // First tick fires after ACTIVE_MS (1000ms)
    await vi.advanceTimersByTimeAsync(1100);
    expect(enqueue).toHaveBeenCalledTimes(1);
  });
});

describe("ticket poller — interval selection: cold picks IDLE_MS", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    process.env["SCRYBE_DAEMON_TICKET_ACTIVE_MS"] = "1000";
    process.env["SCRYBE_DAEMON_TICKET_IDLE_MS"] = "5000";
    delete process.env["SCRYBE_DAEMON_NO_TICKET_FETCH"];
    vi.useFakeTimers();
  });

  afterEach(async () => {
    vi.useRealTimers();
    delete process.env["SCRYBE_DAEMON_TICKET_ACTIVE_MS"];
    delete process.env["SCRYBE_DAEMON_TICKET_IDLE_MS"];
    try {
      const { stopTicketPoller } = await import("../src/daemon/ticket-poller.js");
      stopTicketPoller();
    } catch { /* ignore */ }
  });

  it("schedules first poll at IDLE_MS when state=cold and cursor exists", async () => {
    const { enqueue } = await import("../src/daemon/queue.js");
    const { loadCursor } = await import("../src/cursors.js");
    vi.mocked(loadCursor).mockReturnValue("2024-01-01T00:00:00Z");

    const { getState } = await import("../src/daemon/idle-state.js");
    vi.mocked(getState).mockReturnValue("cold");

    const { initTicketPoller, startTicketPoller } = await import("../src/daemon/ticket-poller.js");
    initTicketPoller({ pushEvent: vi.fn() });
    startTicketPoller([makeProject({})]);

    // IDLE_MS is 5000ms; at 1100ms the tick should NOT have fired
    await vi.advanceTimersByTimeAsync(1100);
    expect(enqueue).not.toHaveBeenCalled();

    // Advance past 5000ms — now it fires
    await vi.advanceTimersByTimeAsync(4000);
    expect(enqueue).toHaveBeenCalledTimes(1);
  });
});

describe("ticket poller — backfill on start: cursorless enqueues at delay=0", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    process.env["SCRYBE_DAEMON_TICKET_ACTIVE_MS"] = "60000";
    process.env["SCRYBE_DAEMON_TICKET_IDLE_MS"] = "360000";
    delete process.env["SCRYBE_DAEMON_NO_TICKET_FETCH"];
    vi.useFakeTimers();
  });

  afterEach(async () => {
    vi.useRealTimers();
    delete process.env["SCRYBE_DAEMON_TICKET_ACTIVE_MS"];
    delete process.env["SCRYBE_DAEMON_TICKET_IDLE_MS"];
    try {
      const { stopTicketPoller } = await import("../src/daemon/ticket-poller.js");
      stopTicketPoller();
    } catch { /* ignore */ }
  });

  it("enqueues immediately (delay 0) when loadCursor returns null", async () => {
    const { enqueue } = await import("../src/daemon/queue.js");
    const { loadCursor } = await import("../src/cursors.js");
    vi.mocked(loadCursor).mockReturnValue(null); // no cursor → backfill

    const { getState } = await import("../src/daemon/idle-state.js");
    vi.mocked(getState).mockReturnValue("hot");

    const { initTicketPoller, startTicketPoller } = await import("../src/daemon/ticket-poller.js");
    initTicketPoller({ pushEvent: vi.fn() });
    startTicketPoller([makeProject({})]);

    // Tick 1ms — the delay=0 timer fires; then it re-enqueues at 60 000ms
    await vi.advanceTimersByTimeAsync(1);

    expect(enqueue).toHaveBeenCalledWith(
      expect.objectContaining({
        projectId: "proj-1",
        sourceId: "gl-issues",
        mode: "incremental",
      })
    );
    // Exactly 1 call (the backfill); next scheduled for 60s, not yet fired
    expect(enqueue).toHaveBeenCalledTimes(1);
  });

  it("does NOT enqueue at delay=0 when loadCursor returns a value", async () => {
    const { enqueue } = await import("../src/daemon/queue.js");
    const { loadCursor } = await import("../src/cursors.js");
    vi.mocked(loadCursor).mockReturnValue("2024-01-01T00:00:00Z"); // has cursor

    const { getState } = await import("../src/daemon/idle-state.js");
    vi.mocked(getState).mockReturnValue("hot");

    const { initTicketPoller, startTicketPoller } = await import("../src/daemon/ticket-poller.js");
    initTicketPoller({ pushEvent: vi.fn() });
    startTicketPoller([makeProject({})]);

    // Advance only 1ms — the ACTIVE_MS timer (60 000ms) has not fired
    await vi.advanceTimersByTimeAsync(1);
    expect(enqueue).not.toHaveBeenCalled();
  });
});

describe("ticket poller — cold→hot catch-up (ticketPollerOnHot)", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    process.env["SCRYBE_DAEMON_TICKET_ACTIVE_MS"] = "60000";
    process.env["SCRYBE_DAEMON_TICKET_IDLE_MS"] = "360000";
    delete process.env["SCRYBE_DAEMON_NO_TICKET_FETCH"];
    vi.useFakeTimers();
  });

  afterEach(async () => {
    vi.useRealTimers();
    delete process.env["SCRYBE_DAEMON_TICKET_ACTIVE_MS"];
    delete process.env["SCRYBE_DAEMON_TICKET_IDLE_MS"];
    try {
      const { stopTicketPoller } = await import("../src/daemon/ticket-poller.js");
      stopTicketPoller();
    } catch { /* ignore */ }
  });

  it("fires one immediate poll per source on ticketPollerOnHot", async () => {
    const { enqueue } = await import("../src/daemon/queue.js");
    const { loadCursor } = await import("../src/cursors.js");
    // Has cursor — normal startup would wait 360 000ms (cold interval)
    vi.mocked(loadCursor).mockReturnValue("2024-06-01T00:00:00Z");

    const { getState } = await import("../src/daemon/idle-state.js");
    vi.mocked(getState).mockReturnValue("cold");

    const { initTicketPoller, startTicketPoller, ticketPollerOnHot } = await import(
      "../src/daemon/ticket-poller.js"
    );
    initTicketPoller({ pushEvent: vi.fn() });
    startTicketPoller([makeProject({})]);

    // Nothing has fired yet at 1ms (cold, 360s interval)
    await vi.advanceTimersByTimeAsync(1);
    expect(enqueue).not.toHaveBeenCalled();

    // Simulate cold→hot transition — schedules delay=0 poll
    ticketPollerOnHot();

    // The immediate (delay=0) timer fires
    await vi.advanceTimersByTimeAsync(1);
    expect(enqueue).toHaveBeenCalledTimes(1);
    expect(enqueue).toHaveBeenCalledWith(
      expect.objectContaining({
        projectId: "proj-1",
        sourceId: "gl-issues",
        mode: "incremental",
      })
    );
  });
});

describe("ticket poller — per-host serialization", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    process.env["SCRYBE_DAEMON_TICKET_ACTIVE_MS"] = "60000";
    delete process.env["SCRYBE_DAEMON_NO_TICKET_FETCH"];
    vi.useFakeTimers();
  });

  afterEach(async () => {
    vi.useRealTimers();
    delete process.env["SCRYBE_DAEMON_TICKET_ACTIVE_MS"];
    try {
      const { stopTicketPoller } = await import("../src/daemon/ticket-poller.js");
      stopTicketPoller();
    } catch { /* ignore */ }
  });

  it("reschedules the second poller for the same host when the first is in-flight", async () => {
    const { loadCursor } = await import("../src/cursors.js");
    vi.mocked(loadCursor).mockReturnValue(null); // both sources cursorless → delay 0

    const { getState } = await import("../src/daemon/idle-state.js");
    vi.mocked(getState).mockReturnValue("hot");

    // First enqueue never resolves → first poll stays in-flight indefinitely
    const { enqueue } = await import("../src/daemon/queue.js");
    let firstCalled = false;
    vi.mocked(enqueue).mockImplementation(() => {
      if (!firstCalled) {
        firstCalled = true;
        return new Promise<string>(() => {}); // in-flight forever
      }
      return Promise.resolve("job-ticket");
    });

    const { initTicketPoller, startTicketPoller } = await import("../src/daemon/ticket-poller.js");
    initTicketPoller({ pushEvent: vi.fn() });

    // Two sources on the same hostname
    const projects = [
      {
        id: "proj-ha",
        description: "host-A project 1",
        sources: [
          {
            source_id: "src-a",
            source_config: {
              type: "ticket" as const,
              provider: "gitlab",
              base_url: "https://shared.gitlab.com",
              project_id: "10",
              token: "tok",
            },
          },
        ],
      },
      {
        id: "proj-hb",
        description: "host-A project 2",
        sources: [
          {
            source_id: "src-b",
            source_config: {
              type: "ticket" as const,
              provider: "gitlab",
              base_url: "https://shared.gitlab.com", // same host
              project_id: "11",
              token: "tok",
            },
          },
        ],
      },
    ];

    startTicketPoller(projects);

    // 1ms: both delay-0 timers fire. First runs (in-flight); second sees host busy → reschedules
    await vi.advanceTimersByTimeAsync(1);
    expect(enqueue).toHaveBeenCalledTimes(1);

    // After 5000ms the second fires again but first is still in-flight → reschedules again
    await vi.advanceTimersByTimeAsync(5100);
    // Still only 1 — first is still blocking the host
    expect(enqueue).toHaveBeenCalledTimes(1);
  });
});

describe("ticket poller — global concurrency cap (MAX_CONCURRENT=2)", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    process.env["SCRYBE_DAEMON_TICKET_ACTIVE_MS"] = "60000";
    delete process.env["SCRYBE_DAEMON_NO_TICKET_FETCH"];
    vi.useFakeTimers();
  });

  afterEach(async () => {
    vi.useRealTimers();
    delete process.env["SCRYBE_DAEMON_TICKET_ACTIVE_MS"];
    try {
      const { stopTicketPoller } = await import("../src/daemon/ticket-poller.js");
      stopTicketPoller();
    } catch { /* ignore */ }
  });

  it("reschedules the 3rd poller when 2 are already in-flight (different hosts)", async () => {
    const { loadCursor } = await import("../src/cursors.js");
    vi.mocked(loadCursor).mockReturnValue(null); // all cursorless → delay 0

    const { getState } = await import("../src/daemon/idle-state.js");
    vi.mocked(getState).mockReturnValue("hot");

    // First two enqueue calls never resolve (in-flight); third should not be reached
    const { enqueue } = await import("../src/daemon/queue.js");
    let callCount = 0;
    vi.mocked(enqueue).mockImplementation(() => {
      callCount++;
      if (callCount <= 2) {
        return new Promise<string>(() => {}); // in-flight forever
      }
      return Promise.resolve("job-ticket");
    });

    const { initTicketPoller, startTicketPoller } = await import("../src/daemon/ticket-poller.js");
    initTicketPoller({ pushEvent: vi.fn() });

    // Three sources on distinct hosts so host-serialization doesn't interfere
    const projects = ["host-x.com", "host-y.com", "host-z.com"].map((host, i) => ({
      id: `proj-cap-${i}`,
      description: `cap test ${i}`,
      sources: [
        {
          source_id: `src-${i}`,
          source_config: {
            type: "ticket" as const,
            provider: "gitlab",
            base_url: `https://${host}`,
            project_id: String(i),
            token: "tok",
          },
        },
      ],
    }));

    startTicketPoller(projects);

    // 1ms: all three delay-0 timers fire. Only first two should reach enqueue.
    await vi.advanceTimersByTimeAsync(1);
    expect(enqueue).toHaveBeenCalledTimes(2);

    // The third reschedules at ~5000ms — advance past it; first two still in-flight
    await vi.advanceTimersByTimeAsync(5100);
    expect(enqueue).toHaveBeenCalledTimes(2); // still only 2
  });
});

describe("ticket poller — exponential backoff on failure", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    process.env["SCRYBE_DAEMON_TICKET_ACTIVE_MS"] = "60000";
    delete process.env["SCRYBE_DAEMON_NO_TICKET_FETCH"];
    vi.useFakeTimers();
  });

  afterEach(async () => {
    vi.useRealTimers();
    delete process.env["SCRYBE_DAEMON_TICKET_ACTIVE_MS"];
    try {
      const { stopTicketPoller } = await import("../src/daemon/ticket-poller.js");
      stopTicketPoller();
    } catch { /* ignore */ }
  });

  it("uses RETRY_BASE_MS=30s on first retry, 60s on second", async () => {
    const { loadCursor } = await import("../src/cursors.js");
    vi.mocked(loadCursor).mockReturnValue(null);

    const { getState } = await import("../src/daemon/idle-state.js");
    vi.mocked(getState).mockReturnValue("hot");

    const { enqueue } = await import("../src/daemon/queue.js");
    vi.mocked(enqueue).mockRejectedValue(new Error("network error"));

    const { initTicketPoller, startTicketPoller } = await import("../src/daemon/ticket-poller.js");
    initTicketPoller({ pushEvent: vi.fn() });
    startTicketPoller([makeProject({})]);

    // Initial poll fires (delay=0), throws → retries=1 → schedules 30s timer
    await vi.advanceTimersByTimeAsync(1);
    expect(enqueue).toHaveBeenCalledTimes(1);

    // Advance 29998ms (total 29999ms from start) — 30s timer has NOT fired yet
    await vi.advanceTimersByTimeAsync(29_998);
    expect(enqueue).toHaveBeenCalledTimes(1);

    // Advance 2ms more (total 30001ms) → 30s timer fires, throws → retries=2 → 60s
    await vi.advanceTimersByTimeAsync(2);
    expect(enqueue).toHaveBeenCalledTimes(2);

    // Advance 59998ms (total ~90001ms from start) — 60s timer has NOT fired yet
    await vi.advanceTimersByTimeAsync(59_998);
    expect(enqueue).toHaveBeenCalledTimes(2);

    // Advance 2ms more → third retry fires
    await vi.advanceTimersByTimeAsync(2);
    expect(enqueue).toHaveBeenCalledTimes(3);
  });

  it("caps delay at RETRY_MAX_MS (10min=600s) for retries >= 11", async () => {
    const { loadCursor } = await import("../src/cursors.js");
    vi.mocked(loadCursor).mockReturnValue(null);

    const { getState } = await import("../src/daemon/idle-state.js");
    vi.mocked(getState).mockReturnValue("hot");

    const { enqueue } = await import("../src/daemon/queue.js");
    let callCount = 0;
    vi.mocked(enqueue).mockImplementation(async () => {
      callCount++;
      // Fail first 11, succeed on 12th
      if (callCount <= 11) throw new Error("fail");
      return "job-ok";
    });

    const { initTicketPoller, startTicketPoller } = await import("../src/daemon/ticket-poller.js");
    initTicketPoller({ pushEvent: vi.fn() });
    startTicketPoller([makeProject({})]);

    // Advance through retries 1..11 and the final success.
    // Cumulative: 1ms + 30s + 60s + 120s + 240s + 480s + cap*6 (at retries 6..11 = 600s each)
    // Retry 6 delay = 30s*2^5 = 960s > 600s → capped at 600s
    // So from retry 6 onward each window is 600s.
    // retries 1..5: 30+60+120+240+480 = 930s
    // retries 6..11: 6*600 = 3600s
    // Total with initial 1ms: 930_000 + 3_600_000 + 1 = 4_530_001ms
    await vi.advanceTimersByTimeAsync(4_530_001 + 1);
    expect(callCount).toBeGreaterThanOrEqual(11);
  });
});

describe("ticket poller — reset on success", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    process.env["SCRYBE_DAEMON_TICKET_ACTIVE_MS"] = "1000";
    delete process.env["SCRYBE_DAEMON_NO_TICKET_FETCH"];
    vi.useFakeTimers();
  });

  afterEach(async () => {
    vi.useRealTimers();
    delete process.env["SCRYBE_DAEMON_TICKET_ACTIVE_MS"];
    try {
      const { stopTicketPoller } = await import("../src/daemon/ticket-poller.js");
      stopTicketPoller();
    } catch { /* ignore */ }
  });

  it("retries resets to 0 after success — next poll uses ACTIVE_MS not a backed-off delay", async () => {
    const { loadCursor } = await import("../src/cursors.js");
    vi.mocked(loadCursor).mockReturnValue(null);

    const { getState } = await import("../src/daemon/idle-state.js");
    vi.mocked(getState).mockReturnValue("hot");

    const { enqueue } = await import("../src/daemon/queue.js");
    let callCount = 0;
    vi.mocked(enqueue).mockImplementation(async () => {
      callCount++;
      if (callCount <= 2) throw new Error("transient");
      return "job-ok";
    });

    const { initTicketPoller, startTicketPoller } = await import("../src/daemon/ticket-poller.js");
    initTicketPoller({ pushEvent: vi.fn() });
    startTicketPoller([makeProject({})]);

    // Initial poll fails → retries=1 → 30s delay
    await vi.advanceTimersByTimeAsync(1);
    expect(callCount).toBe(1);

    // Second poll fails → retries=2 → 60s delay
    await vi.advanceTimersByTimeAsync(30_001);
    expect(callCount).toBe(2);

    // Third poll succeeds → retries resets to 0, next delay = ACTIVE_MS (1000ms)
    await vi.advanceTimersByTimeAsync(60_001);
    expect(callCount).toBe(3);

    // Fourth poll should fire after ACTIVE_MS (1000ms), not 120s
    await vi.advanceTimersByTimeAsync(1100);
    expect(callCount).toBe(4);
  });
});

describe("ticket poller — auth-warn dedup (warnedTokenExpired)", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    process.env["SCRYBE_DAEMON_TICKET_ACTIVE_MS"] = "1000";
    delete process.env["SCRYBE_DAEMON_NO_TICKET_FETCH"];
    vi.useFakeTimers();
  });

  afterEach(async () => {
    vi.useRealTimers();
    delete process.env["SCRYBE_DAEMON_TICKET_ACTIVE_MS"];
    try {
      const { stopTicketPoller } = await import("../src/daemon/ticket-poller.js");
      stopTicketPoller();
    } catch { /* ignore */ }
  });

  /**
   * Count auth-specific warn events: level=warn AND detail contains "hint"
   * (only the first auth warn, not the generic backoff event, has a hint).
   */
  function countAuthWarns(pushEvent: ReturnType<typeof vi.fn>): number {
    return pushEvent.mock.calls.filter(
      ([ev]: [unknown]) =>
        typeof ev === "object" && ev !== null &&
        (ev as { level?: string }).level === "warn" &&
        typeof ((ev as { detail?: Record<string, unknown> }).detail ?? {})["hint"] === "string"
    ).length;
  }

  it("emits auth warn only once on repeated 'expired or invalid' failures", async () => {
    const { loadCursor } = await import("../src/cursors.js");
    vi.mocked(loadCursor).mockReturnValue(null);

    const { getState } = await import("../src/daemon/idle-state.js");
    vi.mocked(getState).mockReturnValue("hot");

    const { enqueue } = await import("../src/daemon/queue.js");
    vi.mocked(enqueue).mockRejectedValue(new Error("Token expired or invalid"));

    const pushEvent = vi.fn();
    const { initTicketPoller, startTicketPoller } = await import("../src/daemon/ticket-poller.js");
    initTicketPoller({ pushEvent });
    startTicketPoller([makeProject({})]);

    // First fail → warnedTokenExpired=false → warn fires; retries=1 → 30s delay
    await vi.advanceTimersByTimeAsync(1);
    expect(countAuthWarns(pushEvent)).toBe(1);

    // Second fail (after 30s) → warnedTokenExpired=true → warn NOT fired again
    await vi.advanceTimersByTimeAsync(30_001);
    expect(countAuthWarns(pushEvent)).toBe(1); // still 1, not 2

    // Third fail (after 60s) → still suppressed
    await vi.advanceTimersByTimeAsync(60_001);
    expect(countAuthWarns(pushEvent)).toBe(1);
  });

  it("resets warnedTokenExpired after a successful poll — next auth failure warns again", async () => {
    const { loadCursor } = await import("../src/cursors.js");
    vi.mocked(loadCursor).mockReturnValue(null);

    const { getState } = await import("../src/daemon/idle-state.js");
    vi.mocked(getState).mockReturnValue("hot");

    const { enqueue } = await import("../src/daemon/queue.js");
    let callCount = 0;
    vi.mocked(enqueue).mockImplementation(async () => {
      callCount++;
      if (callCount === 1) throw new Error("Token expired or invalid"); // fail → warn
      if (callCount === 2) return "job-ok"; // success → reset warned state
      throw new Error("Token expired or invalid"); // fail again → warn again
    });

    const pushEvent = vi.fn();
    const { initTicketPoller, startTicketPoller } = await import("../src/daemon/ticket-poller.js");
    initTicketPoller({ pushEvent });
    startTicketPoller([makeProject({})]);

    // Call 1: auth fail → warn emitted (warnedTokenExpired=true; retries=1 → 30s)
    await vi.advanceTimersByTimeAsync(1);
    expect(callCount).toBe(1);
    expect(countAuthWarns(pushEvent)).toBe(1);

    // Call 2 (after 30s backoff): success → retries=0, warnedTokenExpired=false
    await vi.advanceTimersByTimeAsync(30_001);
    expect(callCount).toBe(2);
    expect(countAuthWarns(pushEvent)).toBe(1); // no new warn on success

    // Call 3 (after ACTIVE_MS=1000ms): auth fail again → warnedTokenExpired was reset → warns again
    await vi.advanceTimersByTimeAsync(1100);
    expect(callCount).toBe(3);
    expect(countAuthWarns(pushEvent)).toBe(2); // re-warned (reset worked)
  });
});

describe("ticket poller — stopTicketPoller clears all timers", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    process.env["SCRYBE_DAEMON_TICKET_ACTIVE_MS"] = "60000";
    delete process.env["SCRYBE_DAEMON_NO_TICKET_FETCH"];
    vi.useFakeTimers();
  });

  afterEach(async () => {
    vi.useRealTimers();
    delete process.env["SCRYBE_DAEMON_TICKET_ACTIVE_MS"];
  });

  it("cancels timers on stop — no further enqueue after stopTicketPoller", async () => {
    const { loadCursor } = await import("../src/cursors.js");
    // cursor present so initial delay = 60 000ms (not 0) → timer is pending
    vi.mocked(loadCursor).mockReturnValue("2024-01-01T00:00:00Z");

    const { getState } = await import("../src/daemon/idle-state.js");
    vi.mocked(getState).mockReturnValue("hot");

    const { enqueue } = await import("../src/daemon/queue.js");

    const { initTicketPoller, startTicketPoller, stopTicketPoller } = await import(
      "../src/daemon/ticket-poller.js"
    );
    initTicketPoller({ pushEvent: vi.fn() });
    startTicketPoller([makeProject({})]);

    // Stop before any timer fires
    stopTicketPoller();

    // Advance well past ACTIVE_MS — no enqueue should have been called
    await vi.advanceTimersByTimeAsync(120_000);
    expect(enqueue).not.toHaveBeenCalled();
  });
});

describe("ticket poller — durable logging (events reach daemon-log.jsonl)", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    delete process.env["SCRYBE_DAEMON_NO_TICKET_FETCH"];
    vi.useFakeTimers();
  });

  afterEach(async () => {
    vi.useRealTimers();
    delete process.env["SCRYBE_DEBUG_TICKET_POLLER"];
    try {
      const { stopTicketPoller } = await import("../src/daemon/ticket-poller.js");
      stopTicketPoller();
    } catch { /* ignore */ }
  });

  /** Filter diagEmit calls to ticket-poller events. */
  function ticketLogEvents(diagEmit: ReturnType<typeof vi.fn>): Array<Record<string, unknown>> {
    return diagEmit.mock.calls
      .map((c) => c[0] as Record<string, unknown>)
      .filter((ev) => {
        const detail = (ev?.["detail"] ?? {}) as Record<string, unknown>;
        return typeof detail["phase"] === "string" && (detail["phase"] as string).startsWith("ticket-poller");
      });
  }

  it("writes the enqueue event to the durable log via diagEmit (not just the SSE ring)", async () => {
    const { loadCursor } = await import("../src/cursors.js");
    vi.mocked(loadCursor).mockReturnValue(null); // cursorless → immediate poll

    const { getState } = await import("../src/daemon/idle-state.js");
    vi.mocked(getState).mockReturnValue("hot");

    // clearAllMocks() keeps implementations — reset enqueue to a success after prior reject tests
    const { enqueue } = await import("../src/daemon/queue.js");
    vi.mocked(enqueue).mockResolvedValue("job-ticket");

    const { diagEmit } = await import("../src/daemon/events.js");
    const { initTicketPoller, startTicketPoller } = await import("../src/daemon/ticket-poller.js");
    initTicketPoller({ pushEvent: vi.fn() });
    startTicketPoller([makeProject({})]);

    await vi.advanceTimersByTimeAsync(1); // fire the delay-0 poll

    const logged = ticketLogEvents(vi.mocked(diagEmit));
    // The enqueue success event must be durably logged.
    expect(logged.some((ev) => ((ev["detail"] as Record<string, unknown>)["enqueued"]) === true)).toBe(true);
  });

  it("writes the debug tick event to the durable log when SCRYBE_DEBUG_TICKET_POLLER=1", async () => {
    process.env["SCRYBE_DEBUG_TICKET_POLLER"] = "1";

    const { loadCursor } = await import("../src/cursors.js");
    vi.mocked(loadCursor).mockReturnValue(null);

    const { getState } = await import("../src/daemon/idle-state.js");
    vi.mocked(getState).mockReturnValue("hot");

    const { enqueue } = await import("../src/daemon/queue.js");
    vi.mocked(enqueue).mockResolvedValue("job-ticket");

    const { diagEmit } = await import("../src/daemon/events.js");
    const { initTicketPoller, startTicketPoller } = await import("../src/daemon/ticket-poller.js");
    initTicketPoller({ pushEvent: vi.fn() });
    startTicketPoller([makeProject({})]);

    await vi.advanceTimersByTimeAsync(1);

    const logged = ticketLogEvents(vi.mocked(diagEmit));
    expect(logged.some((ev) => (ev["detail"] as Record<string, unknown>)["phase"] === "ticket-poller.tick")).toBe(true);
  });
});
