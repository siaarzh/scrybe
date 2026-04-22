/**
 * Phase 5 — Git ref watcher: branch switch detection, commit detection.
 * Uses real @parcel/watcher events on a cloned git fixture.
 * Mocks queue.enqueue so no real reindex runs.
 * Short debounce via SCRYBE_DAEMON_GIT_DEBOUNCE_MS env var.
 * Relies on isolate.ts (setupFiles) for per-test module reset + temp DATA_DIR.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import type { FixtureHandle } from "./helpers/fixtures.js";
import { cloneFixture } from "./helpers/fixtures.js";
import { createBranch, switchBranch, commitFile, getCurrentBranch } from "./helpers/git.js";

// Short debounce — git events are immediate, no need to wait 300 ms
process.env["SCRYBE_DAEMON_GIT_DEBOUNCE_MS"] = "80";

vi.mock("../src/daemon/queue.js", () => ({
  enqueue: vi.fn().mockResolvedValue("job-git"),
  initQueue: vi.fn(),
  getQueueStats: vi.fn().mockReturnValue({ active: 0, pending: 0, maxConcurrent: 1 }),
  stopQueue: vi.fn(),
}));

// ─── Helpers ──────────────────────────────────────────────────────────────

let handle: FixtureHandle;
let defaultBranch: string;
let altBranch: string;

beforeEach(async () => {
  vi.clearAllMocks();
  handle = await cloneFixture("sample-multi-branch-repo");
  defaultBranch = getCurrentBranch(handle);
  // Create a local branch to switch to — avoids remote-tracking DWIM issues
  altBranch = "test-alt-branch";
  createBranch(handle, altBranch);
  switchBranch(handle, defaultBranch); // return to default
});

afterEach(async () => {
  try {
    const { stopGitWatcher } = await import("../src/daemon/git-watcher.js");
    await stopGitWatcher();
  } catch { /* ignore */ }
  await handle.cleanup();
});

// ─── Tests ────────────────────────────────────────────────────────────────

describe("git watcher — branch switch detection", () => {
  it("calls enqueue when HEAD changes (git checkout)", async () => {
    const { enqueue } = await import("../src/daemon/queue.js");
    const { initGitWatcher, watchGitProject } = await import("../src/daemon/git-watcher.js");

    initGitWatcher({ pushEvent: vi.fn() });
    await watchGitProject("proj-git-a", handle.path);

    // Switch to the pre-created local branch
    switchBranch(handle, altBranch);

    await vi.waitUntil(
      () => vi.mocked(enqueue).mock.calls.length > 0,
      { timeout: 5_000, interval: 50 },
    );

    expect(enqueue).toHaveBeenCalledWith(
      expect.objectContaining({ projectId: "proj-git-a", mode: "incremental" })
    );
  });

  it("detects branch change and records it in SSE event", async () => {
    const events: unknown[] = [];
    const { initGitWatcher, watchGitProject } = await import("../src/daemon/git-watcher.js");

    initGitWatcher({ pushEvent: (ev) => events.push(ev) });
    await watchGitProject("proj-git-b", handle.path);

    switchBranch(handle, altBranch);

    await vi.waitUntil(
      () => events.length > 0,
      { timeout: 5_000, interval: 50 },
    );

    const ev = events[0] as { event: string; detail: { branchChanged: boolean; branch: string } };
    expect(ev.event).toBe("watcher.event");
    expect(ev.detail.branchChanged).toBe(true);
    expect(ev.detail.branch).toBe(altBranch);
  });

  it("updates getCachedBranch after a switch", async () => {
    const { initGitWatcher, watchGitProject, getCachedBranch } = await import("../src/daemon/git-watcher.js");

    initGitWatcher({ pushEvent: vi.fn() });
    await watchGitProject("proj-git-c", handle.path);

    expect(getCachedBranch("proj-git-c")).toBe(defaultBranch);

    switchBranch(handle, altBranch);

    await vi.waitUntil(
      () => getCachedBranch("proj-git-c") === altBranch,
      { timeout: 5_000, interval: 50 },
    );
  });
});

describe("git watcher — commit detection", () => {
  it("calls enqueue when a new commit is made on current branch", async () => {
    const { enqueue } = await import("../src/daemon/queue.js");
    const { initGitWatcher, watchGitProject } = await import("../src/daemon/git-watcher.js");

    initGitWatcher({ pushEvent: vi.fn() });
    await watchGitProject("proj-git-d", handle.path);

    // Make a new commit on current branch
    commitFile(handle, "new-feature.ts", "export const x = 42;\n", "add new-feature");

    await vi.waitUntil(
      () => vi.mocked(enqueue).mock.calls.length > 0,
      { timeout: 5_000, interval: 50 },
    );

    expect(enqueue).toHaveBeenCalledWith(
      expect.objectContaining({ projectId: "proj-git-d", mode: "incremental" })
    );
  });

  it("coalesces multiple rapid commits into a single enqueue call", async () => {
    const { enqueue } = await import("../src/daemon/queue.js");
    const { initGitWatcher, watchGitProject } = await import("../src/daemon/git-watcher.js");

    initGitWatcher({ pushEvent: vi.fn() });
    await watchGitProject("proj-git-e", handle.path);

    commitFile(handle, "f1.ts", "const a = 1;\n", "commit 1");
    commitFile(handle, "f2.ts", "const b = 2;\n", "commit 2");
    commitFile(handle, "f3.ts", "const c = 3;\n", "commit 3");

    await vi.waitUntil(
      () => vi.mocked(enqueue).mock.calls.length > 0,
      { timeout: 5_000, interval: 50 },
    );

    // Extra wait to confirm no second burst arrives
    await new Promise<void>((r) => setTimeout(r, 300));
    expect(enqueue).toHaveBeenCalledTimes(1);
  });
});

describe("git watcher — lifecycle", () => {
  it("skips projects without a .git directory", async () => {
    const { mkdtempSync } = await import("node:fs");
    const { tmpdir } = await import("node:os");
    const { initGitWatcher, watchGitProject, getGitWatcherHealth } = await import("../src/daemon/git-watcher.js");

    const noGitDir = mkdtempSync(tmpdir() + "/scrybe-nogit-");
    initGitWatcher({ pushEvent: vi.fn() });
    await watchGitProject("proj-no-git", noGitDir);

    // Should not register a watcher for a non-git directory
    expect(getGitWatcherHealth().has("proj-no-git")).toBe(false);

    const { rmSync } = await import("node:fs");
    rmSync(noGitDir, { recursive: true, force: true });
  });

  it("stopGitWatcher unsubscribes all projects", async () => {
    const { initGitWatcher, watchGitProject, stopGitWatcher, getGitWatcherHealth } = await import("../src/daemon/git-watcher.js");

    initGitWatcher({ pushEvent: vi.fn() });
    await watchGitProject("proj-git-f", handle.path);
    expect(getGitWatcherHealth().size).toBe(1);

    await stopGitWatcher();
    expect(getGitWatcherHealth().size).toBe(0);
  });

  it("no-ops on duplicate watchGitProject call", async () => {
    const { initGitWatcher, watchGitProject, getGitWatcherHealth } = await import("../src/daemon/git-watcher.js");

    initGitWatcher({ pushEvent: vi.fn() });
    await watchGitProject("proj-git-g", handle.path);
    await watchGitProject("proj-git-g", handle.path); // duplicate

    expect(getGitWatcherHealth().size).toBe(1);
  });
});
