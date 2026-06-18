/**
 * Plan 92 Slice 1 — Memory + activity telemetry into daemon-log.jsonl.
 *
 * Focused unit tests for:
 *   1. mem-sampler: periodic sampling, unref, start/stop, getLatestMemSample
 *   2. activity-span: reindex span emitted on job completion (via queue.ts)
 *   3. child-process.spawn / exit records emitted by spawn-detached.ts
 *
 * Relies on isolate.ts (setupFiles) for per-test module reset + temp SCRYBE_DATA_DIR.
 * Does NOT run the full suite — targeted only.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { existsSync, readFileSync } from "fs";
import { join } from "path";
import type { DaemonEvent } from "../src/daemon/http-server.js";

// ─── Mocks (hoisted to top level as required by vitest) ───────────────────

vi.mock("../src/jobs.js", () => ({
  submitJob: vi.fn(),
  submitSourceJob: vi.fn(),
  getJobStatus: vi.fn(),
  cancelJob: vi.fn(),
  cancelAllJobs: vi.fn(),
}));

// Mock registry to avoid needing real projects.json + config.json
vi.mock("../src/registry.js", () => ({
  getProject: vi.fn(),
  getSource: vi.fn(),
  resolveEmbeddingConfig: vi.fn(),
  listProjects: vi.fn(() => []),
  assignTableName: vi.fn(),
  onProjectRemoved: vi.fn(),
}));

// Mock child_process.spawn so spawnDaemonDetached doesn't fork a real process
vi.mock("child_process", async (importOriginal) => {
  const original = await importOriginal<typeof import("child_process")>();
  const { EventEmitter } = await import("events");
  return {
    ...original,
    spawn: vi.fn((_cmd: string, _args: string[], _opts: object) => {
      const child = new EventEmitter() as any;
      child.pid = 99999;
      child.unref = vi.fn();
      return child;
    }),
  };
});

// ─── Lifecycle ────────────────────────────────────────────────────────────

beforeEach(() => {
  vi.clearAllMocks();
  vi.useFakeTimers();
});

afterEach(async () => {
  try {
    const { stopQueue } = await import("../src/daemon/queue.js");
    stopQueue();
  } catch { /* ignore */ }
  try {
    const { _resetMemSamplerForTests } = await import("../src/daemon/mem-sampler.js");
    _resetMemSamplerForTests();
  } catch { /* ignore */ }
  vi.useRealTimers();
});

// ─── Helpers ──────────────────────────────────────────────────────────────

function readJsonlLines(logPath: string): Record<string, unknown>[] {
  if (!existsSync(logPath)) return [];
  return readFileSync(logPath, "utf8")
    .trim()
    .split("\n")
    .filter(Boolean)
    .map((l) => { try { return JSON.parse(l); } catch { return null; } })
    .filter(Boolean) as Record<string, unknown>[];
}

// ─── 1. mem-sampler ───────────────────────────────────────────────────────

describe("mem-sampler", () => {
  it("sampleNow returns rssBytes > 0", async () => {
    const { sampleNow } = await import("../src/daemon/mem-sampler.js");
    const snap = sampleNow();
    expect(snap.rssBytes).toBeGreaterThan(0);
    expect(snap.heapUsedBytes).toBeGreaterThan(0);
    expect(typeof snap.sampledAt).toBe("string");
  });

  it("getLatestMemSample is null before startMemSampler", async () => {
    const { getLatestMemSample, _resetMemSamplerForTests } = await import("../src/daemon/mem-sampler.js");
    _resetMemSamplerForTests();
    expect(getLatestMemSample()).toBeNull();
  });

  it("startMemSampler emits an immediate mem-sample record to daemon-log.jsonl", async () => {
    const logPath = join(process.env["SCRYBE_DATA_DIR"]!, "daemon-log.jsonl");
    delete process.env["SCRYBE_DAEMON_MEM_SAMPLE_MS"];

    const { startMemSampler, _resetMemSamplerForTests } = await import("../src/daemon/mem-sampler.js");
    _resetMemSamplerForTests();
    startMemSampler();

    // startMemSampler emits an initial sample synchronously before arming the interval
    expect(existsSync(logPath)).toBe(true);
    const recs = readJsonlLines(logPath);
    const memRec = recs.find((r) => r["event"] === "mem-sample");
    expect(memRec).toBeDefined();
    expect(memRec!["rssBytes"] as number).toBeGreaterThan(0);
    expect(memRec!["heapUsedBytes"] as number).toBeGreaterThan(0);
    expect(typeof memRec!["ts"]).toBe("string");

    _resetMemSamplerForTests();
  });

  it("startMemSampler emits more samples as the interval fires", async () => {
    const logPath = join(process.env["SCRYBE_DATA_DIR"]!, "daemon-log.jsonl");
    // Use a very short interval (1 s) so fake-timers can advance past it.
    process.env["SCRYBE_DAEMON_MEM_SAMPLE_MS"] = "1000";
    vi.resetModules();

    const { startMemSampler, _resetMemSamplerForTests } = await import("../src/daemon/mem-sampler.js");
    _resetMemSamplerForTests();
    startMemSampler();

    const before = readJsonlLines(logPath).filter((r) => r["event"] === "mem-sample").length;
    vi.advanceTimersByTime(2500);
    const after = readJsonlLines(logPath).filter((r) => r["event"] === "mem-sample").length;

    expect(after).toBeGreaterThan(before);

    _resetMemSamplerForTests();
    delete process.env["SCRYBE_DAEMON_MEM_SAMPLE_MS"];
  });

  it("stopMemSampler prevents further samples", async () => {
    const logPath = join(process.env["SCRYBE_DATA_DIR"]!, "daemon-log.jsonl");
    process.env["SCRYBE_DAEMON_MEM_SAMPLE_MS"] = "500";
    vi.resetModules();

    const { startMemSampler, stopMemSampler, _resetMemSamplerForTests } = await import("../src/daemon/mem-sampler.js");
    _resetMemSamplerForTests();
    startMemSampler();
    stopMemSampler();

    const countAtStop = readJsonlLines(logPath).filter((r) => r["event"] === "mem-sample").length;
    vi.advanceTimersByTime(3000);
    const countAfter = readJsonlLines(logPath).filter((r) => r["event"] === "mem-sample").length;

    expect(countAfter).toBe(countAtStop);

    _resetMemSamplerForTests();
    delete process.env["SCRYBE_DAEMON_MEM_SAMPLE_MS"];
  });

  it("getLatestMemSample is populated after startMemSampler", async () => {
    process.env["SCRYBE_DAEMON_MEM_SAMPLE_MS"] = "60000";
    vi.resetModules();
    const { startMemSampler, getLatestMemSample, _resetMemSamplerForTests } = await import("../src/daemon/mem-sampler.js");
    _resetMemSamplerForTests();
    startMemSampler();

    const snap = getLatestMemSample();
    expect(snap).not.toBeNull();
    expect(snap!.rssBytes).toBeGreaterThan(0);

    _resetMemSamplerForTests();
    delete process.env["SCRYBE_DAEMON_MEM_SAMPLE_MS"];
  });
});

// ─── 2. activity-span for reindex ─────────────────────────────────────────

describe("activity-span — reindex", () => {
  it("emits an activity-span record after a reindex job completes", async () => {
    const { submitJob, getJobStatus } = await import("../src/jobs.js");
    vi.mocked(submitJob).mockReturnValue("job-span-1");
    vi.mocked(getJobStatus).mockReturnValue({
      job_id: "job-span-1",
      project_id: "proj1",
      mode: "incremental",
      status: "done",
      tasks: [],
      started_at: Date.now() - 200,
      finished_at: Date.now(),
      error: null,
    });

    // Registry returns no source (provider will be undefined — acceptable)
    const { getProject, getSource } = await import("../src/registry.js");
    vi.mocked(getProject).mockReturnValue(undefined);
    vi.mocked(getSource).mockReturnValue(undefined);

    const { initQueue, enqueue } = await import("../src/daemon/queue.js");
    initQueue({ pushEvent: vi.fn() });

    await enqueue({ projectId: "proj1", mode: "incremental" });
    vi.advanceTimersByTime(400);

    const logPath = join(process.env["SCRYBE_DATA_DIR"]!, "daemon-log.jsonl");
    const recs = readJsonlLines(logPath);
    const spanRec = recs.find((r) => r["event"] === "activity-span" && r["spanType"] === "reindex");
    expect(spanRec).toBeDefined();
    expect(spanRec!["peakRssBytes"] as number).toBeGreaterThan(0);
    expect(spanRec!["startRssBytes"] as number).toBeGreaterThan(0);
    expect(spanRec!["outcome"]).toBe("ok");
    expect(spanRec!["projectId"]).toBe("proj1");
    expect(typeof spanRec!["ts"]).toBe("string");
  });

  it("tags the activity-span with provider field from diagEmit", async () => {
    // This test verifies the activity-span record shape includes a provider field.
    // We verify by directly emitting a span with a known provider value (the same
    // path that queue.ts takes) and checking the log output.
    const logPath = join(process.env["SCRYBE_DATA_DIR"]!, "daemon-log.jsonl");
    const { diagEmit } = await import("../src/daemon/events.js");
    const { sampleNow } = await import("../src/daemon/mem-sampler.js");

    const start = sampleNow();
    const end = sampleNow();

    // Emit the exact record shape that queue.ts emits for a completed reindex job
    diagEmit({
      event: "activity-span",
      level: "info",
      spanType: "reindex",
      projectId: "proj-local",
      sourceId: "code",
      jobId: "job-prov-1",
      mode: "full",
      durationMs: 500,
      outcome: "ok",
      startRssBytes: start.rssBytes,
      peakRssBytes: Math.max(start.rssBytes, end.rssBytes),
      endRssBytes: end.rssBytes,
      provider: "local",
    });

    const recs = readJsonlLines(logPath);
    const spanRec = recs.find((r) => r["event"] === "activity-span" && r["spanType"] === "reindex");
    expect(spanRec).toBeDefined();
    expect(spanRec!["provider"]).toBe("local");
    expect(spanRec!["peakRssBytes"] as number).toBeGreaterThan(0);
    expect(spanRec!["projectId"]).toBe("proj-local");
  });
});

// ─── 3. activity-span for MCP call (via diagEmit directly) ────────────────

describe("activity-span — mcp-call shape", () => {
  it("diagEmit accepts and logs an activity-span mcp-call record", async () => {
    const logPath = join(process.env["SCRYBE_DATA_DIR"]!, "daemon-log.jsonl");
    const { diagEmit } = await import("../src/daemon/events.js");
    const { sampleNow } = await import("../src/daemon/mem-sampler.js");

    const start = sampleNow();
    // Simulate what mcp-rpc.ts does after a tool call completes
    diagEmit({
      event: "activity-span",
      level: "info",
      spanType: "mcp-call",
      method: "search_code",
      clientId: "test-client",
      durationMs: 42,
      outcome: "ok",
      startRssBytes: start.rssBytes,
      peakRssBytes: start.rssBytes,
      endRssBytes: start.rssBytes,
      provider: undefined,
    });

    const recs = readJsonlLines(logPath);
    const spanRec = recs.find((r) => r["event"] === "activity-span" && r["spanType"] === "mcp-call");
    expect(spanRec).toBeDefined();
    expect(spanRec!["peakRssBytes"] as number).toBeGreaterThan(0);
    expect(spanRec!["startRssBytes"] as number).toBeGreaterThan(0);
    expect(spanRec!["method"]).toBe("search_code");
    expect(spanRec!["outcome"]).toBe("ok");
    expect(typeof spanRec!["ts"]).toBe("string");
  });
});

// ─── 4. child-process lifecycle events ────────────────────────────────────

describe("child-process lifecycle events", () => {
  it("spawnDaemonDetached emits a child-process.spawn record with pid and ppid", async () => {
    const logPath = join(process.env["SCRYBE_DATA_DIR"]!, "daemon-log.jsonl");

    const { spawnDaemonDetached } = await import("../src/daemon/spawn-detached.js");
    spawnDaemonDetached({ execPath: "/usr/bin/node", entryScript: "/tmp/test.js" });

    const recs = readJsonlLines(logPath);
    const spawnRec = recs.find((r) => r["event"] === "child-process.spawn");
    expect(spawnRec).toBeDefined();
    expect(spawnRec!["pid"]).toBe(99999);
    expect(spawnRec!["ppid"]).toBe(process.pid);
    expect(spawnRec!["detached"]).toBe(true);
    expect(typeof spawnRec!["ts"]).toBe("string");
  });

  it("child-process.exit record is emitted when the child exits", async () => {
    const logPath = join(process.env["SCRYBE_DATA_DIR"]!, "daemon-log.jsonl");

    // Need the mocked spawn child emitter to actually emit 'exit'
    const { spawn } = await import("child_process");
    const { spawnDaemonDetached } = await import("../src/daemon/spawn-detached.js");

    spawnDaemonDetached({ execPath: "/usr/bin/node", entryScript: "/tmp/test.js" });

    // Get the child emitter returned by the mocked spawn and emit exit
    const mockSpawn = vi.mocked(spawn);
    const lastChild = mockSpawn.mock.results.at(-1)?.value as any;
    expect(lastChild).toBeDefined();
    lastChild.emit("exit", 0, null);

    const recs = readJsonlLines(logPath);
    const exitRec = recs.find((r) => r["event"] === "child-process.exit");
    expect(exitRec).toBeDefined();
    expect(exitRec!["pid"]).toBe(99999);
    expect(exitRec!["ppid"]).toBe(process.pid);
    expect(exitRec!["exitCode"]).toBe(0);
  });
});
