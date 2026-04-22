/**
 * Phase 4 — FS watcher: event detection, debounce coalescing, ignore rules.
 * Uses real @parcel/watcher events and real timers (no fake timers — actual FS I/O).
 * Mocks queue.enqueue so no real reindex runs.
 * Uses a short debounce via SCRYBE_DAEMON_FS_DEBOUNCE_MS env var.
 * Relies on isolate.ts (setupFiles) for per-test module reset.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { mkdirSync, writeFileSync, rmSync } from "fs";
import { join } from "path";
import { tmpdir } from "os";

// Short debounce so tests don't wait 1.5 s each
process.env["SCRYBE_DAEMON_FS_DEBOUNCE_MS"] = "80";

vi.mock("../src/daemon/queue.js", () => ({
  enqueue: vi.fn().mockResolvedValue("job-fs"),
  initQueue: vi.fn(),
  getQueueStats: vi.fn().mockReturnValue({ active: 0, pending: 0, maxConcurrent: 1 }),
  stopQueue: vi.fn(),
}));

// ─── Helpers ──────────────────────────────────────────────────────────────

let tmpDir: string;

beforeEach(() => {
  vi.clearAllMocks();
  tmpDir = join(tmpdir(), `scrybe-watch-${process.pid}-${Date.now()}`);
  mkdirSync(tmpDir, { recursive: true });
});

afterEach(async () => {
  try {
    const { stopWatcher } = await import("../src/daemon/watcher.js");
    await stopWatcher();
  } catch { /* ignore */ }
  rmSync(tmpDir, { recursive: true, force: true });
});

// ─── Tests ────────────────────────────────────────────────────────────────

describe("FS watcher — event detection", () => {
  it("calls enqueue after a file is written (within 5 s)", async () => {
    const { enqueue } = await import("../src/daemon/queue.js");
    const { initWatcher, watchProject } = await import("../src/daemon/watcher.js");

    initWatcher({ pushEvent: vi.fn() });
    await watchProject("proj-a", tmpDir);

    writeFileSync(join(tmpDir, "hello.ts"), "export const x = 1;\n");

    await vi.waitUntil(
      () => vi.mocked(enqueue).mock.calls.length > 0,
      { timeout: 5_000, interval: 50 },
    );

    expect(enqueue).toHaveBeenCalledWith({ projectId: "proj-a", mode: "incremental" });
  });

  it("coalesces rapid writes into a single enqueue call", async () => {
    const { enqueue } = await import("../src/daemon/queue.js");
    const { initWatcher, watchProject } = await import("../src/daemon/watcher.js");

    initWatcher({ pushEvent: vi.fn() });
    await watchProject("proj-b", tmpDir);

    // Write several files in rapid succession — all should be batched
    for (let i = 0; i < 5; i++) {
      writeFileSync(join(tmpDir, `file-${i}.ts`), `export const v${i} = ${i};\n`);
    }

    // Wait for debounce to fire
    await vi.waitUntil(
      () => vi.mocked(enqueue).mock.calls.length > 0,
      { timeout: 5_000, interval: 50 },
    );

    // Small extra wait to confirm no second call arrives
    await new Promise<void>((r) => setTimeout(r, 300));

    expect(enqueue).toHaveBeenCalledTimes(1);
  });

  it("emits watcher.event via pushEvent on file change", async () => {
    const { initWatcher, watchProject } = await import("../src/daemon/watcher.js");

    const events: unknown[] = [];
    initWatcher({ pushEvent: (ev) => events.push(ev) });
    await watchProject("proj-c", tmpDir);

    writeFileSync(join(tmpDir, "changed.ts"), "const z = 99;\n");

    await vi.waitUntil(
      () => events.length > 0,
      { timeout: 5_000, interval: 50 },
    );

    const ev = events[0] as { event: string; projectId: string };
    expect(ev.event).toBe("watcher.event");
    expect(ev.projectId).toBe("proj-c");
  });
});

describe("FS watcher — ignore rules", () => {
  it("ignores .git directory changes", async () => {
    const { enqueue } = await import("../src/daemon/queue.js");
    const { initWatcher, watchProject } = await import("../src/daemon/watcher.js");

    initWatcher({ pushEvent: vi.fn() });
    await watchProject("proj-d", tmpDir);

    // Write inside .git — should be ignored natively by parcel
    const gitDir = join(tmpDir, ".git");
    mkdirSync(gitDir, { recursive: true });
    writeFileSync(join(gitDir, "COMMIT_EDITMSG"), "test\n");

    // Wait longer than debounce to confirm no call
    await new Promise<void>((r) => setTimeout(r, 600));
    expect(enqueue).not.toHaveBeenCalled();
  });

  it("respects .gitignore rules via post-filter", async () => {
    const { enqueue } = await import("../src/daemon/queue.js");
    const { initWatcher, watchProject } = await import("../src/daemon/watcher.js");

    // Write .gitignore before subscribing
    writeFileSync(join(tmpDir, ".gitignore"), "ignored-dir/\n*.log\n");
    mkdirSync(join(tmpDir, "ignored-dir"), { recursive: true });

    initWatcher({ pushEvent: vi.fn() });
    await watchProject("proj-e", tmpDir);

    // Write a file that's gitignored
    writeFileSync(join(tmpDir, "debug.log"), "some log\n");
    writeFileSync(join(tmpDir, "ignored-dir", "stuff.ts"), "const x = 1;\n");

    // Wait longer than debounce
    await new Promise<void>((r) => setTimeout(r, 600));
    expect(enqueue).not.toHaveBeenCalled();

    // Write a non-ignored file to confirm watcher IS working
    writeFileSync(join(tmpDir, "real.ts"), "export const ok = true;\n");
    await vi.waitUntil(
      () => vi.mocked(enqueue).mock.calls.length > 0,
      { timeout: 5_000, interval: 50 },
    );
    expect(enqueue).toHaveBeenCalledTimes(1);
  });
});

describe("FS watcher — lifecycle", () => {
  it("watchProject no-ops if project is already watched", async () => {
    const { initWatcher, watchProject, getWatcherHealth } = await import("../src/daemon/watcher.js");

    initWatcher({ pushEvent: vi.fn() });
    await watchProject("proj-f", tmpDir);
    await watchProject("proj-f", tmpDir); // duplicate — should be silent no-op

    expect(getWatcherHealth().size).toBe(1);
    expect(getWatcherHealth().get("proj-f")).toBe(true);
  });

  it("stopWatcher unsubscribes all projects", async () => {
    const { initWatcher, watchProject, stopWatcher, getWatcherHealth } = await import("../src/daemon/watcher.js");

    initWatcher({ pushEvent: vi.fn() });
    await watchProject("proj-g", tmpDir);
    expect(getWatcherHealth().size).toBe(1);

    await stopWatcher();
    expect(getWatcherHealth().size).toBe(0);
  });
});
