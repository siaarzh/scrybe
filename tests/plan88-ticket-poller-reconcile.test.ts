/**
 * Ticket poller reconcile tests — Plan 88.
 *
 * Tests the reconcileTicketPollers() function and its two wiring points:
 *  - D2 hook 2: ticketPollerOnHot() calls reconcile before rescheduling
 *  - D1: boot path (startTicketPoller) and reconcile share one registration code path
 *
 * Strategy: same as ticket-poller.test.ts — mock registry, queue, cursors, idle-state,
 * events; fake timers; clear mock call history in beforeEach.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { writeFileSync, mkdirSync } from "node:fs";
import { join } from "node:path";

// ─── Mocks ────────────────────────────────────────────────────────────────────

vi.mock("../src/registry.js", () => ({
  listProjects: vi.fn(() => []),
}));

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

vi.mock("../src/daemon/events.js", () => ({
  diagEmit: vi.fn(),
}));

// ─── Helpers ──────────────────────────────────────────────────────────────────

function makeProject(opts: {
  id?: string;
  sourceId?: string;
  baseUrl?: string;
  token?: string;
}) {
  return {
    id: opts.id ?? "proj-1",
    description: "reconcile test project",
    sources: [
      {
        source_id: opts.sourceId ?? "gl-issues",
        source_config: {
          type: "ticket" as const,
          provider: "gitlab",
          base_url: opts.baseUrl ?? "https://gitlab.example.com",
          project_id: "42",
          token: opts.token ?? "tok",
        },
      },
    ],
  };
}

// ─── Tests: reconcileTicketPollers picks up new sources (acceptance 1) ────────

describe("reconcileTicketPollers — adds new ticket sources at runtime", () => {
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

  it("source added to registry after boot is picked up by reconcileTicketPollers and gets scheduled", async () => {
    const { listProjects } = await import("../src/registry.js");
    const { enqueue } = await import("../src/daemon/queue.js");
    const { loadCursor } = await import("../src/cursors.js");
    const { getState } = await import("../src/daemon/idle-state.js");

    // Boot with no ticket sources
    vi.mocked(listProjects).mockReturnValue([]);
    vi.mocked(loadCursor).mockReturnValue("2024-01-01T00:00:00Z");
    vi.mocked(getState).mockReturnValue("hot");

    const { initTicketPoller, startTicketPoller, reconcileTicketPollers } = await import(
      "../src/daemon/ticket-poller.js"
    );
    initTicketPoller({ pushEvent: vi.fn() });
    startTicketPoller([]);

    // No pollers yet — advance well past any interval
    await vi.advanceTimersByTimeAsync(2000);
    expect(enqueue).not.toHaveBeenCalled();

    // Source is added to registry
    const newProject = makeProject({ id: "proj-runtime", sourceId: "src-new" });
    vi.mocked(listProjects).mockReturnValue([newProject]);

    // Reconcile — simulates what the D2 job-path hook triggers
    reconcileTicketPollers();

    // New poller has cursor → scheduled at ACTIVE_MS (1000ms)
    await vi.advanceTimersByTimeAsync(0);
    expect(enqueue).not.toHaveBeenCalled(); // not yet — ACTIVE_MS hasn't elapsed

    await vi.advanceTimersByTimeAsync(1100);
    expect(enqueue).toHaveBeenCalledTimes(1);
    expect(enqueue).toHaveBeenCalledWith(
      expect.objectContaining({
        projectId: "proj-runtime",
        sourceId: "src-new",
        mode: "incremental",
      })
    );
  });

  it("source with no cursor (backfill) is polled immediately on reconcile", async () => {
    const { listProjects } = await import("../src/registry.js");
    const { enqueue } = await import("../src/daemon/queue.js");
    const { loadCursor } = await import("../src/cursors.js");
    const { getState } = await import("../src/daemon/idle-state.js");

    vi.mocked(listProjects).mockReturnValue([]);
    vi.mocked(loadCursor).mockReturnValue(null); // no cursor → backfill delay 0
    vi.mocked(getState).mockReturnValue("hot");

    const { initTicketPoller, startTicketPoller, reconcileTicketPollers } = await import(
      "../src/daemon/ticket-poller.js"
    );
    initTicketPoller({ pushEvent: vi.fn() });
    startTicketPoller([]);

    const newProject = makeProject({ id: "proj-backfill", sourceId: "src-bf" });
    vi.mocked(listProjects).mockReturnValue([newProject]);

    reconcileTicketPollers();

    // delay=0 timer fires immediately
    await vi.advanceTimersByTimeAsync(1);
    expect(enqueue).toHaveBeenCalledTimes(1);
    expect(enqueue).toHaveBeenCalledWith(
      expect.objectContaining({ projectId: "proj-backfill", sourceId: "src-bf" })
    );
  });

  it("reconcile is a no-op for sources already registered at boot", async () => {
    const { listProjects } = await import("../src/registry.js");
    const { enqueue } = await import("../src/daemon/queue.js");
    const { loadCursor } = await import("../src/cursors.js");
    const { getState } = await import("../src/daemon/idle-state.js");

    const project = makeProject({});
    vi.mocked(listProjects).mockReturnValue([project]);
    vi.mocked(loadCursor).mockReturnValue(null); // backfill
    vi.mocked(getState).mockReturnValue("hot");

    const { initTicketPoller, startTicketPoller, reconcileTicketPollers } = await import(
      "../src/daemon/ticket-poller.js"
    );
    initTicketPoller({ pushEvent: vi.fn() });
    startTicketPoller([project]);

    // Fire initial backfill poll
    await vi.advanceTimersByTimeAsync(1);
    expect(enqueue).toHaveBeenCalledTimes(1);

    // Reconcile again — same source, already registered — should not double-schedule
    reconcileTicketPollers();
    await vi.advanceTimersByTimeAsync(1);
    // enqueue was called only 1 time total (from the backfill) — no double-fire
    expect(enqueue).toHaveBeenCalledTimes(1);
  });
});

// ─── Tests: reconcileTicketPollers removes vanished sources (acceptance 2) ────

describe("reconcileTicketPollers — removes vanished ticket sources", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    process.env["SCRYBE_DAEMON_TICKET_ACTIVE_MS"] = "60000";
    process.env["SCRYBE_DAEMON_TICKET_IDLE_MS"] = "360000";
    delete process.env["SCRYBE_DAEMON_NO_TICKET_FETCH"];
    vi.useFakeTimers();
    // Create a projects.json in the test data dir so that reconcile knows the
    // registry exists and removal of vanished sources is enabled.
    const dataDir = process.env["SCRYBE_DATA_DIR"]!;
    mkdirSync(dataDir, { recursive: true });
    writeFileSync(join(dataDir, "projects.json"), "[]", "utf8");
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

  it("source removed from registry is stopped and removed from poller map on reconcile", async () => {
    const { listProjects } = await import("../src/registry.js");
    const { enqueue } = await import("../src/daemon/queue.js");
    const { loadCursor } = await import("../src/cursors.js");
    const { getState } = await import("../src/daemon/idle-state.js");

    const project = makeProject({ id: "proj-remove", sourceId: "src-gone" });
    vi.mocked(listProjects).mockReturnValue([project]);
    vi.mocked(loadCursor).mockReturnValue("2024-01-01T00:00:00Z"); // cursor → cadence delay
    vi.mocked(getState).mockReturnValue("hot");

    const { initTicketPoller, startTicketPoller, ticketPollerOnHot } = await import(
      "../src/daemon/ticket-poller.js"
    );
    initTicketPoller({ pushEvent: vi.fn() });
    startTicketPoller([project]);

    // Source is removed from registry
    vi.mocked(listProjects).mockReturnValue([]);

    // Trigger via hot path (D2 hook 2 — reconcile happens inside ticketPollerOnHot)
    ticketPollerOnHot();

    // No timer should fire — the poller was stopped
    await vi.advanceTimersByTimeAsync(120_000);
    expect(enqueue).not.toHaveBeenCalled();
  });

  it("removed source timer is cleared immediately on reconcile (via ticketPollerOnHot)", async () => {
    const { listProjects } = await import("../src/registry.js");
    const { loadCursor } = await import("../src/cursors.js");
    const { getState } = await import("../src/daemon/idle-state.js");

    const project = makeProject({ id: "proj-timer", sourceId: "src-timer" });
    vi.mocked(listProjects).mockReturnValue([project]);
    vi.mocked(loadCursor).mockReturnValue("2024-01-01T00:00:00Z");
    vi.mocked(getState).mockReturnValue("cold");

    const { initTicketPoller, startTicketPoller, reconcileTicketPollers } = await import(
      "../src/daemon/ticket-poller.js"
    );
    initTicketPoller({ pushEvent: vi.fn() });
    startTicketPoller([project]);

    // Source is gone from registry
    vi.mocked(listProjects).mockReturnValue([]);

    // Direct reconcile (not via hot — tests bare reconcile path)
    reconcileTicketPollers();

    // The timer should have been cleared. Advance well past idle interval.
    const { enqueue } = await import("../src/daemon/queue.js");
    await vi.advanceTimersByTimeAsync(500_000);
    expect(enqueue).not.toHaveBeenCalled();
  });
});

// ─── Tests: literal-token warn fires once for runtime-added sources (acceptance 3) ───

describe("reconcileTicketPollers — literal-token warn for runtime-added sources", () => {
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

  function countLiteralTokenWarns(pushEvent: ReturnType<typeof vi.fn>): number {
    return pushEvent.mock.calls.filter(
      ([ev]: [unknown]) =>
        typeof ev === "object" && ev !== null &&
        (ev as { level?: string }).level === "warn" &&
        typeof ((ev as { detail?: Record<string, unknown> }).detail ?? {})["literalTokenWarn"] === "boolean" &&
        ((ev as { detail?: Record<string, unknown> }).detail as Record<string, unknown>)["literalTokenWarn"] === true
    ).length;
  }

  it("literal-token warn fires exactly once for a runtime-added source with a literal token", async () => {
    const { listProjects } = await import("../src/registry.js");
    const { loadCursor } = await import("../src/cursors.js");
    const { getState } = await import("../src/daemon/idle-state.js");

    // Boot with no sources
    vi.mocked(listProjects).mockReturnValue([]);
    vi.mocked(loadCursor).mockReturnValue("2024-01-01T00:00:00Z");
    vi.mocked(getState).mockReturnValue("hot");

    const pushEvent = vi.fn();
    const { initTicketPoller, startTicketPoller, reconcileTicketPollers } = await import(
      "../src/daemon/ticket-poller.js"
    );
    initTicketPoller({ pushEvent });
    startTicketPoller([]);

    // Add a source with a literal token (no ${VAR} reference)
    const projectLiteral = makeProject({ id: "proj-literal", token: "plaintext-token" });
    vi.mocked(listProjects).mockReturnValue([projectLiteral]);

    // First reconcile — should warn
    reconcileTicketPollers();
    expect(countLiteralTokenWarns(pushEvent)).toBe(1);

    // Second reconcile — same source already registered, warn must NOT fire again
    reconcileTicketPollers();
    expect(countLiteralTokenWarns(pushEvent)).toBe(1);
  });

  it("literal-token warn does NOT fire for a source with an env-ref token", async () => {
    const { listProjects } = await import("../src/registry.js");
    const { loadCursor } = await import("../src/cursors.js");
    const { getState } = await import("../src/daemon/idle-state.js");

    vi.mocked(listProjects).mockReturnValue([]);
    vi.mocked(loadCursor).mockReturnValue("2024-01-01T00:00:00Z");
    vi.mocked(getState).mockReturnValue("hot");

    const pushEvent = vi.fn();
    const { initTicketPoller, startTicketPoller, reconcileTicketPollers } = await import(
      "../src/daemon/ticket-poller.js"
    );
    initTicketPoller({ pushEvent });
    startTicketPoller([]);

    const projectEnvRef = makeProject({ id: "proj-envref", token: "${MY_GITLAB_TOKEN}" });
    vi.mocked(listProjects).mockReturnValue([projectEnvRef]);

    reconcileTicketPollers();
    expect(countLiteralTokenWarns(pushEvent)).toBe(0);
  });
});

// ─── Tests: ticketPollerOnHot reconciles before rescheduling (D2 hook 2) ─────

describe("ticketPollerOnHot — reconciles before catch-up polls", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    process.env["SCRYBE_DAEMON_TICKET_ACTIVE_MS"] = "60000";
    process.env["SCRYBE_DAEMON_TICKET_IDLE_MS"] = "360000";
    delete process.env["SCRYBE_DAEMON_NO_TICKET_FETCH"];
    vi.useFakeTimers();
    // Ensure projects.json exists so reconcile removal is enabled
    const dataDir = process.env["SCRYBE_DATA_DIR"]!;
    mkdirSync(dataDir, { recursive: true });
    writeFileSync(join(dataDir, "projects.json"), "[]", "utf8");
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

  it("source added before ticketPollerOnHot is scheduled and gets a catch-up poll", async () => {
    const { listProjects } = await import("../src/registry.js");
    const { enqueue } = await import("../src/daemon/queue.js");
    const { loadCursor } = await import("../src/cursors.js");
    const { getState } = await import("../src/daemon/idle-state.js");

    // Boot with no sources
    vi.mocked(listProjects).mockReturnValue([]);
    vi.mocked(loadCursor).mockReturnValue("2024-01-01T00:00:00Z");
    vi.mocked(getState).mockReturnValue("cold");

    const { initTicketPoller, startTicketPoller, ticketPollerOnHot } = await import(
      "../src/daemon/ticket-poller.js"
    );
    initTicketPoller({ pushEvent: vi.fn() });
    startTicketPoller([]);

    // Source added while cold — no polls yet
    const newProject = makeProject({ id: "proj-hot", sourceId: "src-hot" });
    vi.mocked(listProjects).mockReturnValue([newProject]);

    // Transition cold→hot: ticketPollerOnHot reconciles then reschedules all at delay=0
    ticketPollerOnHot();

    await vi.advanceTimersByTimeAsync(1);
    expect(enqueue).toHaveBeenCalledTimes(1);
    expect(enqueue).toHaveBeenCalledWith(
      expect.objectContaining({ projectId: "proj-hot", sourceId: "src-hot" })
    );
  });

  it("source removed before ticketPollerOnHot is not rescheduled", async () => {
    const { listProjects } = await import("../src/registry.js");
    const { enqueue } = await import("../src/daemon/queue.js");
    const { loadCursor } = await import("../src/cursors.js");
    const { getState } = await import("../src/daemon/idle-state.js");

    const project = makeProject({ id: "proj-hot-remove", sourceId: "src-hot-gone" });
    vi.mocked(listProjects).mockReturnValue([project]);
    vi.mocked(loadCursor).mockReturnValue("2024-01-01T00:00:00Z");
    vi.mocked(getState).mockReturnValue("cold");

    const { initTicketPoller, startTicketPoller, ticketPollerOnHot } = await import(
      "../src/daemon/ticket-poller.js"
    );
    initTicketPoller({ pushEvent: vi.fn() });
    startTicketPoller([project]);

    // Remove source, then transition to hot
    vi.mocked(listProjects).mockReturnValue([]);
    ticketPollerOnHot();

    await vi.advanceTimersByTimeAsync(120_000);
    expect(enqueue).not.toHaveBeenCalled();
  });
});

// ─── Tests: SKIP_TICKET_FETCH guard applies to reconcile ──────────────────────

describe("reconcileTicketPollers — respects SKIP_TICKET_FETCH guard", () => {
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

  it("reconcileTicketPollers is a no-op when SCRYBE_DAEMON_NO_TICKET_FETCH=1", async () => {
    const { listProjects } = await import("../src/registry.js");
    const { enqueue } = await import("../src/daemon/queue.js");

    const project = makeProject({});
    vi.mocked(listProjects).mockReturnValue([project]);

    const { initTicketPoller, reconcileTicketPollers } = await import(
      "../src/daemon/ticket-poller.js"
    );
    initTicketPoller({ pushEvent: vi.fn() });

    reconcileTicketPollers();
    await vi.runAllTimersAsync();

    expect(enqueue).not.toHaveBeenCalled();
    // listProjects should NOT have been called (early return before registry read)
    expect(listProjects).not.toHaveBeenCalled();
  });
});

// ─── Tests: ticketPollerOnJobEvent — D2 hook 1 wiring ────────────────────────

describe("ticketPollerOnJobEvent — triggers reconcile for ticket-source submitted jobs", () => {
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

  it("submitted reindex job for a ticket source NOT in poller map triggers reconcile → poller registered and scheduled", async () => {
    const { listProjects } = await import("../src/registry.js");
    const { enqueue } = await import("../src/daemon/queue.js");
    const { loadCursor } = await import("../src/cursors.js");
    const { getState } = await import("../src/daemon/idle-state.js");

    // Boot with no ticket sources
    vi.mocked(listProjects).mockReturnValue([]);
    vi.mocked(loadCursor).mockReturnValue("2024-01-01T00:00:00Z"); // cursor → cadence delay
    vi.mocked(getState).mockReturnValue("hot");

    const { initTicketPoller, startTicketPoller, ticketPollerOnJobEvent } = await import(
      "../src/daemon/ticket-poller.js"
    );
    initTicketPoller({ pushEvent: vi.fn() });
    startTicketPoller([]);

    // No pollers yet — ensure no enqueue activity
    await vi.advanceTimersByTimeAsync(2000);
    expect(enqueue).not.toHaveBeenCalled();

    // Now a new ticket source exists in the registry
    const newProject = makeProject({ id: "proj-job-event", sourceId: "src-ticket-job" });
    vi.mocked(listProjects).mockReturnValue([newProject]);

    // Simulate a "submitted" reindex job event for the ticket source (as main.ts wires it)
    ticketPollerOnJobEvent(
      "proj-job-event",
      "job-id-1",
      "submitted",
      { projectId: "proj-job-event", sourceId: "src-ticket-job", mode: "incremental" },
    );

    // Poller should now be registered and scheduled at ACTIVE_MS (1000ms)
    // Advance just past ACTIVE_MS so the timer fires
    await vi.advanceTimersByTimeAsync(1100);
    expect(enqueue).toHaveBeenCalledTimes(1);
    expect(enqueue).toHaveBeenCalledWith(
      expect.objectContaining({
        projectId: "proj-job-event",
        sourceId: "src-ticket-job",
        mode: "incremental",
      }),
    );
  });

  it("submitted reindex job for a code source does not trigger reconcile or registration", async () => {
    const { listProjects } = await import("../src/registry.js");
    const { enqueue } = await import("../src/daemon/queue.js");
    const { loadCursor } = await import("../src/cursors.js");
    const { getState } = await import("../src/daemon/idle-state.js");

    // Registry has a ticket source — but we will NOT fire a ticket-type job event
    const ticketProject = makeProject({ id: "proj-code-test", sourceId: "src-code-job" });
    // Override to present it as a code source so listProjects check short-circuits
    vi.mocked(listProjects).mockReturnValue([
      {
        id: "proj-code-test",
        description: "code source project",
        sources: [
          {
            source_id: "src-code-job",
            source_config: {
              type: "code" as const,
              root_path: "/some/path",
            },
          },
        ],
      },
    ]);
    vi.mocked(loadCursor).mockReturnValue("2024-01-01T00:00:00Z");
    vi.mocked(getState).mockReturnValue("hot");

    const { initTicketPoller, startTicketPoller, ticketPollerOnJobEvent } = await import(
      "../src/daemon/ticket-poller.js"
    );
    initTicketPoller({ pushEvent: vi.fn() });
    startTicketPoller([]);

    // Fire a "submitted" job event for the code source
    ticketPollerOnJobEvent(
      "proj-code-test",
      "job-id-2",
      "submitted",
      { projectId: "proj-code-test", sourceId: "src-code-job", mode: "incremental" },
    );

    // Advance well past any would-be poller interval
    await vi.advanceTimersByTimeAsync(10_000);

    // enqueue should never be called — no ticket poller was registered
    expect(enqueue).not.toHaveBeenCalled();

    // Also verify that a non-"submitted" event type does not trigger anything.
    // Re-configure registry with a ticket source to confirm the eventType guard works.
    vi.clearAllMocks();
    vi.mocked(listProjects).mockReturnValue([ticketProject]);
    vi.mocked(enqueue).mockResolvedValue("noop" as unknown as void);

    ticketPollerOnJobEvent(
      "proj-code-test",
      "job-id-3",
      "completed", // non-submitted event — should be ignored
      { projectId: "proj-code-test", sourceId: "src-ticket-job", mode: "incremental" },
    );

    await vi.advanceTimersByTimeAsync(10_000);
    expect(enqueue).not.toHaveBeenCalled();
    // listProjects should NOT have been consulted for a non-submitted event
    expect(listProjects).not.toHaveBeenCalled();
  });
});
