/**
 * Phase 11 — Acceptance / sanity tests.
 *
 * 1. FS watcher unhealthy detection (unit) — verifies that a subscription failure
 *    on a non-existent path is immediately reflected in getWatcherHealth().
 *
 * 2. HTTP /status reflects watcher health (integration) — starts a real daemon
 *    process with a project whose root_path does not exist, then checks that
 *    /status returns watcherHealthy=false and gitWatcherHealthy=false.
 *    This is the "sabotage" acceptance check: the HTTP API must correctly
 *    expose health state so M-D3 can surface it to the user.
 *
 * 3. HTTP /status reports watcherHealthy=true for a healthy project.
 */

// ──────────────────────────────────────────────────────────────────────────────
// PART 1 — Unit-level watcher unhealthy detection (mocked queue, same process)
// ──────────────────────────────────────────────────────────────────────────────

import { describe, it, expect, vi, afterEach } from "vitest";
import { mkdtempSync, rmSync, writeFileSync } from "fs";
import { join } from "path";
import { tmpdir } from "os";
import { startTempDaemon } from "./helpers/daemon.js";
import type { TempDaemon } from "./helpers/daemon.js";

process.env["SCRYBE_DAEMON_FS_DEBOUNCE_MS"] = "80";

vi.mock("../src/daemon/queue.js", () => ({
  enqueue: vi.fn().mockResolvedValue("job-accept"),
  initQueue: vi.fn(),
  getQueueStats: vi.fn().mockReturnValue({ active: 0, pending: 0, maxConcurrent: 1 }),
  stopQueue: vi.fn(),
}));

afterEach(async () => {
  try {
    const { stopWatcher } = await import("../src/daemon/watcher.js");
    await stopWatcher();
  } catch { /* ignore */ }
  try {
    const { stopGitWatcher } = await import("../src/daemon/git-watcher.js");
    await stopGitWatcher();
  } catch { /* ignore */ }
});

describe("FS watcher — unhealthy detection (unit)", () => {
  it("marks project unhealthy immediately when path does not exist at subscribe time", async () => {
    const nonExistent = join(tmpdir(), `scrybe-noexist-${Date.now()}`);

    const events: { event: string }[] = [];
    const { initWatcher, watchProject, getWatcherHealth } = await import("../src/daemon/watcher.js");

    initWatcher({ pushEvent: (ev) => events.push(ev as typeof events[0]) });
    await watchProject("proj-sabotage-unit", nonExistent);

    // After the first subscribe() failure, ws.healthy is set to false immediately
    expect(getWatcherHealth().get("proj-sabotage-unit")).toBe(false);

    // A watcher.event SSE with error detail should have been emitted
    expect(events.some((e) => e.event === "watcher.event")).toBe(true);
  });

  it("git watcher silently skips non-git directories (no entry in health map)", async () => {
    const noGitDir = mkdtempSync(join(tmpdir(), "scrybe-nogit-accept-"));
    try {
      const { initGitWatcher, watchGitProject, getGitWatcherHealth } = await import("../src/daemon/git-watcher.js");
      initGitWatcher({ pushEvent: vi.fn() });
      await watchGitProject("proj-no-git-accept", noGitDir);
      // resolveGitDir returns null → watchGitProject returns early → no entry
      expect(getGitWatcherHealth().has("proj-no-git-accept")).toBe(false);
    } finally {
      rmSync(noGitDir, { recursive: true, force: true });
    }
  });
});

// ──────────────────────────────────────────────────────────────────────────────
// PART 2 — HTTP /status reflects watcher health (integration, real daemon process)
// ──────────────────────────────────────────────────────────────────────────────

describe("daemon /status — watcher health reflected via HTTP (integration)", () => {
  let daemon: TempDaemon | null = null;

  afterEach(async () => {
    if (daemon) { await daemon.stop(); daemon = null; }
  });

  it("reports watcherHealthy=false for a project whose root_path does not exist", async () => {
    const dataDir = mkdtempSync(join(tmpdir(), "scrybe-accept-bad-"));
    const badPath = join(dataDir, "nonexistent-repo");

    writeFileSync(
      join(dataDir, "projects.json"),
      JSON.stringify([{
        id: "test-unhealthy-http",
        description: "Acceptance test project",
        sources: [{
          source_id: "primary",
          source_config: { type: "code", root_path: badPath },
          embedding: { base_url: "http://127.0.0.1:12345", model: "test", dimensions: 384, api_key_env: "EMBEDDING_API_KEY" },
        }],
      }]),
      "utf8",
    );

    daemon = await startTempDaemon({ dataDir, projects: [] });

    // Give watcher a moment to attempt (and fail) the subscription
    await new Promise<void>((r) => setTimeout(r, 1000));

    const status = await daemon.client.status();
    const proj = status.projects.find((p) => p.projectId === "test-unhealthy-http");

    expect(proj).toBeDefined();
    expect(proj!.watcherHealthy).toBe(false);
    expect(proj!.gitWatcherHealthy).toBe(false);

    rmSync(dataDir, { recursive: true, force: true });
  });

  it("reports watcherHealthy=true for a project whose root_path exists", async () => {
    const dataDir = mkdtempSync(join(tmpdir(), "scrybe-accept-good-"));
    const repoDir = mkdtempSync(join(tmpdir(), "scrybe-accept-repo-"));

    writeFileSync(
      join(dataDir, "projects.json"),
      JSON.stringify([{
        id: "test-healthy-http",
        description: "Acceptance test healthy project",
        sources: [{
          source_id: "primary",
          source_config: { type: "code", root_path: repoDir },
          embedding: { base_url: "http://127.0.0.1:12345", model: "test", dimensions: 384, api_key_env: "EMBEDDING_API_KEY" },
        }],
      }]),
      "utf8",
    );

    daemon = await startTempDaemon({ dataDir, projects: [] });

    // Give watcher time to subscribe
    await new Promise<void>((r) => setTimeout(r, 1000));

    const status = await daemon.client.status();
    const proj = status.projects.find((p) => p.projectId === "test-healthy-http");

    expect(proj).toBeDefined();
    expect(proj!.watcherHealthy).toBe(true);

    rmSync(dataDir, { recursive: true, force: true });
    rmSync(repoDir, { recursive: true, force: true });
  });
});
