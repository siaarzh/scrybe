/**
 * Phase 6 — Fetch poller: backfill detection, SHA delta detection, no-fetch skip.
 * Uses two real clones (remote + local) to simulate git fetch workflows.
 * Mocks queue.enqueue and branch-tags.getBranchesForSource for isolation.
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

vi.mock("../src/branch-tags.js", () => ({
  getBranchesForSource: vi.fn().mockReturnValue([]),
  closeBranchTagsDB: vi.fn(),
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
    // getBranchesForSource returns [] by default → branch never indexed

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

    expect(enqueue).toHaveBeenCalledWith(
      expect.objectContaining({
        projectId: "fp-p1",
        sourceId: "primary",
        branch: "origin/feat/example",
        mode: "incremental",
      })
    );
  });
});

describe("fetch poller — SHA delta detection", () => {
  it("queues reindex when a pinned branch advances on the remote", async () => {
    const { enqueue } = await import("../src/daemon/queue.js");
    const { getBranchesForSource } = await import("../src/branch-tags.js");
    // Pretend the branch was already indexed — only SHA changes should trigger
    vi.mocked(getBranchesForSource).mockReturnValue(["origin/feat/example"]);

    // Commit to feat/example on the remote BEFORE starting the poller
    // (so the poller's first snapshot captures the pre-commit SHA,
    //  then the fetch updates local to the post-commit SHA)
    execSync(`git -C "${remote.path}" checkout feat/example`, { stdio: "ignore" });
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

    expect(enqueue).toHaveBeenCalledWith(
      expect.objectContaining({
        projectId: "fp-p2",
        sourceId: "primary",
        branch: "origin/feat/example",
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
    // getBranchesForSource = [] → would normally queue on first cycle

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
