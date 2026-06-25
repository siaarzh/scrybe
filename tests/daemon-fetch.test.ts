/**
 * Phase 6 — Fetch poller: backfill detection, SHA delta detection, no-fetch skip.
 * Uses two real clones (remote + local) to simulate git fetch workflows.
 * Mocks queue.enqueue and branch-state.listBranches for isolation.
 * Relies on isolate.ts (setupFiles) for per-test DATA_DIR + module reset.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { execSync } from "child_process";
import type { FixtureHandle } from "./helpers/fixtures.js";
import { cloneFixture, cloneLocal } from "./helpers/fixtures.js";
import { commitFile } from "./helpers/git.js";

// Short intervals so tests don't wait for real 5-minute cycles
process.env["SCRYBE_DAEMON_FETCH_ACTIVE_MS"] = "500";
process.env["SCRYBE_DAEMON_FETCH_IDLE_MS"] = "500";

vi.mock("../src/daemon/queue.js", () => ({
  enqueue: vi.fn().mockResolvedValue("job-fetch"),
  initQueue: vi.fn(),
  getQueueStats: vi.fn().mockReturnValue({ active: 0, pending: 0, maxConcurrent: 1 }),
  stopQueue: vi.fn(),
}));

vi.mock("../src/branch-state.js", () => ({
  listBranches: vi.fn().mockReturnValue([]),
  closeDB: vi.fn(),
  getAllChunkIdsForSource: vi.fn().mockReturnValue(new Set()),
  getChunkIdsForBranch: vi.fn().mockReturnValue(new Set()),
  resolveBranch: vi.fn().mockReturnValue("main"),
  resolveBranchForPath: vi.fn().mockReturnValue("main"),
  getLastIndexedSha: vi.fn().mockReturnValue(null),
  setLastIndexedSha: vi.fn(),
}));

// ─── Helpers ──────────────────────────────────────────────────────────────

let remote: FixtureHandle;
let local: FixtureHandle;

beforeEach(async () => {
  vi.clearAllMocks();
  // remote = "origin server"; local = working clone with origin → remote
  remote = await cloneFixture("sample-multi-branch-repo");
  local = cloneLocal(remote.path);
});

afterEach(async () => {
  try {
    const { stopFetchPoller } = await import("../src/daemon/fetch-poller.js");
    stopFetchPoller();
  } catch { /* ignore */ }
  await local.cleanup();
  await remote.cleanup();
});

// ─── Tests ────────────────────────────────────────────────────────────────

describe("fetch poller — backfill", () => {
  it("queues incremental reindex for a pinned branch never indexed before", async () => {
    const { enqueue } = await import("../src/daemon/queue.js");
    // listBranches returns [] by default → branch never indexed

    const { addProject, addSource, updateSource, listProjects } = await import("../src/registry.js");
    addProject({ id: "fp-p1", description: "fetch-poller test" });
    addSource("fp-p1", {
      source_id: "primary",
      source_config: { type: "code", root_path: local.path, languages: ["typescript"] },
    });
    updateSource("fp-p1", "primary", { pinned_branches: ["feat/example"] });

    const { initFetchPoller, startFetchPoller } = await import("../src/daemon/fetch-poller.js");
    initFetchPoller({ pushEvent: vi.fn() });
    startFetchPoller(listProjects());

    await vi.waitUntil(
      () => vi.mocked(enqueue).mock.calls.length > 0,
      { timeout: 5_000, interval: 50 },
    );

    // D1: branch label is the logical name; contentRef carries the remote-tracking ref
    expect(enqueue).toHaveBeenCalledWith(
      expect.objectContaining({
        projectId: "fp-p1",
        sourceId: "primary",
        branch: "feat/example",
        contentRef: "origin/feat/example",
        mode: "incremental",
      })
    );
  });
});

describe("fetch poller — SHA delta detection", () => {
  it("queues reindex when a pinned branch advances on the remote", async () => {
    const { enqueue } = await import("../src/daemon/queue.js");
    const { listBranches, getLastIndexedSha } = await import("../src/branch-state.js");
    // Pretend the branch was already indexed with an old SHA — SHA delta should trigger enqueue.
    // D1: branch_tags and branch_state use logical names, not origin/-prefixed refs.
    vi.mocked(listBranches).mockReturnValue(["feat/example"]);
    vi.mocked(getLastIndexedSha).mockReturnValue("aaaa000000000000000000000000000000000000");

    // Commit to feat/example on the remote BEFORE starting the poller
    // (so the poller's first snapshot captures the pre-commit SHA,
    //  then the fetch updates local to the post-commit SHA)
    try {
      execSync(`git -C "${remote.path}" checkout feat/example`, { stdio: "ignore" });
    } catch {
      execSync(`git -C "${remote.path}" checkout -b feat/example origin/feat/example`, { stdio: "ignore" });
    }
    commitFile(remote, "new-remote-file.ts", "export const x = 1;\n", "remote advance");
    execSync(`git -C "${remote.path}" checkout -`, { stdio: "ignore" });

    const { addProject, addSource, updateSource, listProjects } = await import("../src/registry.js");
    addProject({ id: "fp-p2", description: "fetch-poller test" });
    addSource("fp-p2", {
      source_id: "primary",
      source_config: { type: "code", root_path: local.path, languages: ["typescript"] },
    });
    updateSource("fp-p2", "primary", { pinned_branches: ["feat/example"] });

    const { initFetchPoller, startFetchPoller } = await import("../src/daemon/fetch-poller.js");
    initFetchPoller({ pushEvent: vi.fn() });
    startFetchPoller(listProjects());

    await vi.waitUntil(
      () => vi.mocked(enqueue).mock.calls.length > 0,
      { timeout: 5_000, interval: 50 },
    );

    // D1: branch is the logical label; contentRef is the upstream read ref
    expect(enqueue).toHaveBeenCalledWith(
      expect.objectContaining({
        projectId: "fp-p2",
        sourceId: "primary",
        branch: "feat/example",
        contentRef: "origin/feat/example",
        mode: "incremental",
      })
    );
  });

  it("does not enqueue when no pinned branches are configured", async () => {
    const { enqueue } = await import("../src/daemon/queue.js");

    const { addProject, addSource, listProjects } = await import("../src/registry.js");
    addProject({ id: "fp-p3", description: "fetch-poller test" });
    addSource("fp-p3", {
      source_id: "primary",
      source_config: { type: "code", root_path: local.path, languages: ["typescript"] },
    });
    // no pinned_branches set

    const { initFetchPoller, startFetchPoller } = await import("../src/daemon/fetch-poller.js");
    initFetchPoller({ pushEvent: vi.fn() });
    startFetchPoller(listProjects());

    // Wait longer than one full cycle
    await new Promise<void>((r) => setTimeout(r, 700));
    expect(enqueue).not.toHaveBeenCalled();
  });
});

describe("fetch poller — lifecycle", () => {
  it("stopFetchPoller cancels all timers (no enqueue after stop)", async () => {
    const { enqueue } = await import("../src/daemon/queue.js");
    // listBranches = [] → would normally queue on first cycle

    const { addProject, addSource, updateSource, listProjects } = await import("../src/registry.js");
    addProject({ id: "fp-p4", description: "fetch-poller test" });
    addSource("fp-p4", {
      source_id: "primary",
      source_config: { type: "code", root_path: local.path, languages: ["typescript"] },
    });
    updateSource("fp-p4", "primary", { pinned_branches: ["feat/example"] });

    const { initFetchPoller, startFetchPoller, stopFetchPoller } = await import("../src/daemon/fetch-poller.js");
    initFetchPoller({ pushEvent: vi.fn() });
    startFetchPoller(listProjects());

    // Stop immediately before the first timer fires
    stopFetchPoller();

    await new Promise<void>((r) => setTimeout(r, 700));
    expect(enqueue).not.toHaveBeenCalled();
  });
});

describe("fetch poller — out-of-band race fix (Plan 50)", () => {
  afterEach(() => {
    delete process.env["SCRYBE_DEBUG_FETCH_POLLER"];
  });

  it("#1 — race repro: out-of-band fetch is detected and enqueue is called", async () => {
    // Arrange: commit to remote, then pre-fetch the local clone so the ref is
    // already at the new SHA before the poller runs its own git fetch.
    // This means shaBefore === shaAfter (daemon's fetch is a no-op), yet
    // lastIndexedSha differs → out-of-band detection triggers.
    const { execSync: exec } = await import("child_process");

    try {
      exec(`git -C "${remote.path}" checkout feat/example`, { stdio: "ignore" });
    } catch {
      exec(`git -C "${remote.path}" checkout -b feat/example origin/feat/example`, { stdio: "ignore" });
    }
    exec(`git -C "${remote.path}" commit --allow-empty -m "oob advance"`, { stdio: "ignore" });
    exec(`git -C "${remote.path}" checkout -`, { stdio: "ignore" });

    // Pre-fetch the local clone so origin/feat/example is already at new SHA
    exec(`git -C "${local.path}" fetch origin`, { stdio: "ignore" });

    const { enqueue } = await import("../src/daemon/queue.js");
    const { listBranches, getLastIndexedSha } = await import("../src/branch-state.js");
    // Branch is in branch_state with an old SHA.  D1: keyed under logical name.
    vi.mocked(listBranches).mockReturnValue(["feat/example"]);
    vi.mocked(getLastIndexedSha).mockReturnValue("aaaa000000000000000000000000000000000000");

    const pushedEvents: unknown[] = [];
    const pushEvent = vi.fn((ev: unknown) => { pushedEvents.push(ev); });

    const { addProject, addSource, updateSource, listProjects } = await import("../src/registry.js");
    addProject({ id: "fp-oob1", description: "oob race test" });
    addSource("fp-oob1", {
      source_id: "primary",
      source_config: { type: "code", root_path: local.path, languages: ["typescript"] },
    });
    updateSource("fp-oob1", "primary", { pinned_branches: ["feat/example"] });

    const { initFetchPoller, startFetchPoller } = await import("../src/daemon/fetch-poller.js");
    initFetchPoller({ pushEvent });
    startFetchPoller(listProjects());

    await vi.waitUntil(
      () => vi.mocked(enqueue).mock.calls.length > 0,
      { timeout: 5_000, interval: 50 },
    );

    // D1: branch label is logical; contentRef carries the remote-tracking ref
    expect(enqueue).toHaveBeenCalledWith(
      expect.objectContaining({
        projectId: "fp-oob1",
        sourceId: "primary",
        branch: "feat/example",
        contentRef: "origin/feat/example",
        mode: "incremental",
      })
    );

    const oobEvents = pushedEvents.filter(
      (ev) =>
        typeof ev === "object" && ev !== null &&
        ((ev as Record<string, unknown>)["detail"] as Record<string, unknown> | undefined)?.["outOfBandFetch"] === true
    );
    expect(oobEvents.length).toBeGreaterThan(0);
  });

  it("#2 — bootstrap on upgrade: no enqueue, setLastIndexedSha called with current SHA under logical name", async () => {
    const { enqueue } = await import("../src/daemon/queue.js");
    const { listBranches, getLastIndexedSha, setLastIndexedSha } = await import("../src/branch-state.js");
    // branch_state empty (getLastIndexedSha returns null) but branch_tags has rows.
    // D1: branch_tags uses the logical name, not origin/-prefixed.
    vi.mocked(listBranches).mockReturnValue(["feat/example"]);
    vi.mocked(getLastIndexedSha).mockReturnValue(null);

    const { addProject, addSource, updateSource, listProjects } = await import("../src/registry.js");
    addProject({ id: "fp-boot2", description: "bootstrap test" });
    addSource("fp-boot2", {
      source_id: "primary",
      source_config: { type: "code", root_path: local.path, languages: ["typescript"] },
    });
    updateSource("fp-boot2", "primary", { pinned_branches: ["feat/example"] });

    const { initFetchPoller, startFetchPoller } = await import("../src/daemon/fetch-poller.js");
    initFetchPoller({ pushEvent: vi.fn() });
    startFetchPoller(listProjects());

    // Wait long enough for the first cycle to complete
    await new Promise<void>((r) => setTimeout(r, 2_000));

    // No enqueue should have been called (bootstrap skips it)
    expect(enqueue).not.toHaveBeenCalled();

    // setLastIndexedSha should be keyed under the logical branch name (D1)
    expect(setLastIndexedSha).toHaveBeenCalledWith(
      "fp-boot2",
      "primary",
      "feat/example",
      expect.stringMatching(/^[0-9a-f]{40}$/)
    );
  });

  it("#3 — happy-path delta: daemon's own fetch advances ref, enqueue called", async () => {
    const { execSync: exec } = await import("child_process");
    const { enqueue } = await import("../src/daemon/queue.js");
    const { listBranches, getLastIndexedSha } = await import("../src/branch-state.js");

    // branch_state has an old SHA.  D1: keyed under logical name.
    vi.mocked(listBranches).mockReturnValue(["feat/example"]);
    vi.mocked(getLastIndexedSha).mockReturnValue("aaaa000000000000000000000000000000000000");

    // Advance the remote BEFORE starting the poller, but do NOT pre-fetch locally.
    // The daemon's own git fetch will be the one that advances origin/feat/example.
    try {
      exec(`git -C "${remote.path}" checkout feat/example`, { stdio: "ignore" });
    } catch {
      exec(`git -C "${remote.path}" checkout -b feat/example origin/feat/example`, { stdio: "ignore" });
    }
    exec(`git -C "${remote.path}" commit --allow-empty -m "happy-path advance"`, { stdio: "ignore" });
    exec(`git -C "${remote.path}" checkout -`, { stdio: "ignore" });

    const { addProject, addSource, updateSource, listProjects } = await import("../src/registry.js");
    addProject({ id: "fp-delta3", description: "happy-path delta test" });
    addSource("fp-delta3", {
      source_id: "primary",
      source_config: { type: "code", root_path: local.path, languages: ["typescript"] },
    });
    updateSource("fp-delta3", "primary", { pinned_branches: ["feat/example"] });

    const { initFetchPoller, startFetchPoller } = await import("../src/daemon/fetch-poller.js");
    initFetchPoller({ pushEvent: vi.fn() });
    startFetchPoller(listProjects());

    await vi.waitUntil(
      () => vi.mocked(enqueue).mock.calls.length > 0,
      { timeout: 5_000, interval: 50 },
    );

    // D1: branch label is logical; contentRef carries the remote-tracking ref
    expect(enqueue).toHaveBeenCalledWith(
      expect.objectContaining({
        projectId: "fp-delta3",
        sourceId: "primary",
        branch: "feat/example",
        contentRef: "origin/feat/example",
        mode: "incremental",
      })
    );
  });

  it("#4 — truly never indexed: branch_state empty AND no branch_tags rows → enqueue", async () => {
    const { enqueue } = await import("../src/daemon/queue.js");
    const { listBranches, getLastIndexedSha } = await import("../src/branch-state.js");
    // Both empty — completely new branch
    vi.mocked(listBranches).mockReturnValue([]);
    vi.mocked(getLastIndexedSha).mockReturnValue(null);

    const { addProject, addSource, updateSource, listProjects } = await import("../src/registry.js");
    addProject({ id: "fp-new4", description: "truly never indexed test" });
    addSource("fp-new4", {
      source_id: "primary",
      source_config: { type: "code", root_path: local.path, languages: ["typescript"] },
    });
    updateSource("fp-new4", "primary", { pinned_branches: ["feat/example"] });

    const { initFetchPoller, startFetchPoller } = await import("../src/daemon/fetch-poller.js");
    initFetchPoller({ pushEvent: vi.fn() });
    startFetchPoller(listProjects());

    await vi.waitUntil(
      () => vi.mocked(enqueue).mock.calls.length > 0,
      { timeout: 5_000, interval: 50 },
    );

    // D1: branch label is logical; contentRef carries the remote-tracking ref
    expect(enqueue).toHaveBeenCalledWith(
      expect.objectContaining({
        projectId: "fp-new4",
        sourceId: "primary",
        branch: "feat/example",
        contentRef: "origin/feat/example",
        mode: "incremental",
      })
    );
  });

  it("#9 — out-of-band telemetry shape: watcher.event payload matches spec exactly", async () => {
    const { execSync: exec } = await import("child_process");

    try {
      exec(`git -C "${remote.path}" checkout feat/example`, { stdio: "ignore" });
    } catch {
      exec(`git -C "${remote.path}" checkout -b feat/example origin/feat/example`, { stdio: "ignore" });
    }
    exec(`git -C "${remote.path}" commit --allow-empty -m "oob shape test"`, { stdio: "ignore" });
    exec(`git -C "${remote.path}" checkout -`, { stdio: "ignore" });

    // Pre-fetch local clone so shaBefore === shaAfter (out-of-band condition)
    exec(`git -C "${local.path}" fetch origin`, { stdio: "ignore" });

    const { enqueue } = await import("../src/daemon/queue.js");
    const { listBranches, getLastIndexedSha } = await import("../src/branch-state.js");
    const oldSha = "bbbb000000000000000000000000000000000000";
    // D1: branch_tags stores the logical name, not origin/-prefixed
    vi.mocked(listBranches).mockReturnValue(["feat/example"]);
    vi.mocked(getLastIndexedSha).mockReturnValue(oldSha);

    const pushedEvents: unknown[] = [];
    const pushEvent = vi.fn((ev: unknown) => { pushedEvents.push(ev); });

    const { addProject, addSource, updateSource, listProjects } = await import("../src/registry.js");
    addProject({ id: "fp-oob9", description: "oob telemetry shape test" });
    addSource("fp-oob9", {
      source_id: "primary",
      source_config: { type: "code", root_path: local.path, languages: ["typescript"] },
    });
    updateSource("fp-oob9", "primary", { pinned_branches: ["feat/example"] });

    const { initFetchPoller, startFetchPoller } = await import("../src/daemon/fetch-poller.js");
    initFetchPoller({ pushEvent });
    startFetchPoller(listProjects());

    await vi.waitUntil(
      () => vi.mocked(enqueue).mock.calls.length > 0,
      { timeout: 5_000, interval: 50 },
    );

    const oobEvent = pushedEvents.find(
      (ev) =>
        typeof ev === "object" && ev !== null &&
        ((ev as Record<string, unknown>)["detail"] as Record<string, unknown> | undefined)?.["outOfBandFetch"] === true
    ) as Record<string, unknown> | undefined;

    expect(oobEvent).toBeDefined();
    const detail = oobEvent!["detail"] as Record<string, unknown>;
    expect(detail["phase"]).toBe("fetch-poller");
    expect(detail["outOfBandFetch"]).toBe(true);
    expect(detail["branch"]).toBe("origin/feat/example");
    expect(detail["lastSha"]).toBe(oldSha);
    expect(typeof detail["shaAfter"]).toBe("string");
    expect((detail["shaAfter"] as string).length).toBe(40);
  });
});

describe("fetch poller — debug heartbeat", () => {
  afterEach(() => {
    delete process.env["SCRYBE_DEBUG_FETCH_POLLER"];
  });

  it("emits a fetch-poller.tick event when SCRYBE_DEBUG_FETCH_POLLER=1", async () => {
    process.env["SCRYBE_DEBUG_FETCH_POLLER"] = "1";

    const pushedEvents: unknown[] = [];
    const pushEvent = vi.fn((ev: unknown) => { pushedEvents.push(ev); });

    const { addProject, addSource, updateSource, listProjects } = await import("../src/registry.js");
    addProject({ id: "fp-p5", description: "fetch-poller heartbeat test" });
    addSource("fp-p5", {
      source_id: "primary",
      source_config: { type: "code", root_path: local.path, languages: ["typescript"] },
    });
    updateSource("fp-p5", "primary", { pinned_branches: ["feat/example"] });

    const { initFetchPoller, startFetchPoller } = await import("../src/daemon/fetch-poller.js");
    initFetchPoller({ pushEvent });
    startFetchPoller(listProjects());

    await vi.waitUntil(
      () => pushedEvents.some(
        (ev) =>
          typeof ev === "object" &&
          ev !== null &&
          (ev as Record<string, unknown>)["detail"] !== undefined &&
          ((ev as Record<string, unknown>)["detail"] as Record<string, unknown>)["phase"] === "fetch-poller.tick"
      ),
      { timeout: 5_000, interval: 50 },
    );

    const tickEvents = pushedEvents.filter(
      (ev) =>
        typeof ev === "object" &&
        ev !== null &&
        ((ev as Record<string, unknown>)["detail"] as Record<string, unknown> | undefined)?.["phase"] === "fetch-poller.tick"
    );
    expect(tickEvents.length).toBeGreaterThan(0);
  });

  it("does not emit fetch-poller.tick events when SCRYBE_DEBUG_FETCH_POLLER is unset", async () => {
    // Env var deliberately not set (afterEach ensures clean state)
    const pushedEvents: unknown[] = [];
    const pushEvent = vi.fn((ev: unknown) => { pushedEvents.push(ev); });

    const { addProject, addSource, updateSource, listProjects } = await import("../src/registry.js");
    addProject({ id: "fp-p6", description: "fetch-poller no-heartbeat test" });
    addSource("fp-p6", {
      source_id: "primary",
      source_config: { type: "code", root_path: local.path, languages: ["typescript"] },
    });
    updateSource("fp-p6", "primary", { pinned_branches: ["feat/example"] });

    const { initFetchPoller, startFetchPoller } = await import("../src/daemon/fetch-poller.js");
    initFetchPoller({ pushEvent });
    startFetchPoller(listProjects());

    // Wait long enough for at least one full cycle to complete (git fetch + processing)
    // Mirror the pattern used in the "no pinned branches" test
    await new Promise<void>((r) => setTimeout(r, 2_000));

    const tickEvents = pushedEvents.filter(
      (ev) =>
        typeof ev === "object" &&
        ev !== null &&
        ((ev as Record<string, unknown>)["detail"] as Record<string, unknown> | undefined)?.["phase"] === "fetch-poller.tick"
    );
    expect(tickEvents.length).toBe(0);
  });
});
