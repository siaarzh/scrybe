/**
 * Plan 117 — per-phase memory telemetry.
 *
 * The two properties that make this instrumentation worth having (and which
 * the previous `activity-span` record lacked) are tested directly:
 *
 *   1. CRASH SAFETY — a phase record is on disk the moment that phase ends, so
 *      a process killed in phase N still leaves phases 1..N-1 behind. Test:
 *      read the log from *inside* a later phase and assert the earlier ones are
 *      already there. Also asserted for a phase that throws.
 *   2. REAL PEAK — peakRssBytes is a high-water mark sampled during the phase,
 *      not max(entry, exit). Test: allocate inside the phase, sample, release,
 *      and assert the record's peak exceeds both endpoints.
 *
 * Plus: the log is a separate sink from daemon-log.jsonl (retention), segment
 * rolling is time-bounded, and the poll timer is unref-ed and always cleared.
 *
 * Relies on tests/isolate.ts for per-test vi.resetModules() + temp data dir,
 * which is what lets each case set module-load-time env vars.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { existsSync, readFileSync, writeFileSync } from "fs";
import { join } from "path";

const PHASE_LOG = () => join(process.env["SCRYBE_DATA_DIR"]!, "phase-log.jsonl");

function readPhaseLog(path = PHASE_LOG()): Array<Record<string, any>> {
  if (!existsSync(path)) return [];
  return readFileSync(path, "utf8")
    .split("\n")
    .filter((l) => l.trim().length > 0)
    .map((l) => JSON.parse(l));
}

const CTX = {
  projectId: "proj",
  sourceId: "src",
  jobId: "job-1",
  branch: "master",
  mode: "incremental",
};

beforeEach(() => {
  delete process.env["SCRYBE_PHASE_LOG_PATH"];
  delete process.env["SCRYBE_PHASE_SEGMENT_MS"];
  delete process.env["SCRYBE_PHASE_RSS_POLL_MS"];
  delete process.env["SCRYBE_PHASE_TELEMETRY"];
  delete process.env["SCRYBE_PHASE_LOG_MAX_BYTES"];
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe("withPhase — record shape and identity", () => {
  it("emits one record per phase with join keys, RSS triple and work counters", async () => {
    const { withPhase } = await import("../src/daemon/phase-telemetry.js");

    await withPhase(CTX, "scan", async (phase) => {
      phase.setWork({ sources_found: 42, scan_kind: "working-tree" });
      phase.sample();
    });

    const records = readPhaseLog();
    expect(records).toHaveLength(1);
    const r = records[0]!;
    expect(r.event).toBe("indexer.phase");
    expect(r.phase).toBe("scan");
    expect(r.projectId).toBe("proj");
    expect(r.sourceId).toBe("src");
    expect(r.jobId).toBe("job-1");
    expect(r.branch).toBe("master");
    expect(r.mode).toBe("incremental");
    expect(r.outcome).toBe("ok");
    expect(r.final).toBe(true);
    expect(r.seq).toBe(0);
    expect(typeof r.startRssBytes).toBe("number");
    expect(typeof r.endRssBytes).toBe("number");
    expect(typeof r.peakRssBytes).toBe("number");
    expect(typeof r.durationMs).toBe("number");
    expect(r.work).toEqual({ sources_found: 42, scan_kind: "working-tree" });
  });

  it("stamps the daemon pid exactly once, via the shared events.ts constant", async () => {
    const { withPhase } = await import("../src/daemon/phase-telemetry.js");
    await withPhase(CTX, "scan", async () => {});

    const raw = readFileSync(PHASE_LOG(), "utf8").trim();
    const r = JSON.parse(raw);
    expect(r.pid).toBe(process.pid);
    // Exactly one pid key in the serialized line — no second stamp.
    expect(raw.match(/"pid":/g)).toHaveLength(1);
  });
});

describe("withPhase — crash safety (records land as the phase ends)", () => {
  it("an earlier phase is already readable from disk while a later one runs", async () => {
    const { withPhase } = await import("../src/daemon/phase-telemetry.js");

    await withPhase(CTX, "scan", async () => {});

    let seenFromInsideDiff: string[] = [];
    await withPhase(CTX, "diff", async () => {
      // This is the whole point: if the process were SIGKILLed right here,
      // "scan" would still be on disk.
      seenFromInsideDiff = readPhaseLog().map((r) => r.phase);
    });

    expect(seenFromInsideDiff).toEqual(["scan"]);
    expect(readPhaseLog().map((r) => r.phase)).toEqual(["scan", "diff"]);
  });

  it("emits with outcome=error when the phase throws, and rethrows", async () => {
    const { withPhase } = await import("../src/daemon/phase-telemetry.js");

    await expect(
      withPhase(CTX, "compact", async (phase) => {
        phase.setWork({ compacted: false });
        throw new Error("lance exploded");
      }),
    ).rejects.toThrow("lance exploded");

    const records = readPhaseLog();
    expect(records).toHaveLength(1);
    expect(records[0]!.outcome).toBe("error");
    expect(records[0]!.work).toEqual({ compacted: false });
  });

  it("classifies INDEX_CANCELLED as outcome=cancelled, not error", async () => {
    const { withPhase } = await import("../src/daemon/phase-telemetry.js");

    await expect(
      withPhase(CTX, "chunk_embed", async () => {
        throw new Error("INDEX_CANCELLED");
      }),
    ).rejects.toThrow("INDEX_CANCELLED");

    expect(readPhaseLog()[0]!.outcome).toBe("cancelled");
  });
});

describe("withPhase — peak is a high-water mark, not max(entry, exit)", () => {
  it("records an interior peak above both endpoints", async () => {
    const { withPhase } = await import("../src/daemon/phase-telemetry.js");

    await withPhase(CTX, "scan", async (phase) => {
      // Touch every page so the allocation is resident, sample, then release.
      let hog: Buffer | null = Buffer.alloc(96 * 1024 * 1024, 1);
      phase.sample();
      hog = null;
      void hog;
    });

    const r = readPhaseLog()[0]!;
    expect(r.peakRssBytes).toBeGreaterThan(r.startRssBytes);
    expect(r.peakRssBytes).toBeGreaterThanOrEqual(r.endRssBytes);
  });
});

describe("withPhase — timer hygiene", () => {
  it("unref()s the poll timer and clears it on both success and failure", async () => {
    const cleared: unknown[] = [];
    const unreffed: unknown[] = [];
    const realSetInterval = globalThis.setInterval;
    vi.spyOn(globalThis, "setInterval").mockImplementation(((fn: any, ms: any) => {
      const t = realSetInterval(fn, ms);
      const realUnref = t.unref.bind(t);
      t.unref = () => { unreffed.push(t); return realUnref(); };
      return t;
    }) as any);
    const realClearInterval = globalThis.clearInterval;
    vi.spyOn(globalThis, "clearInterval").mockImplementation(((t: any) => {
      cleared.push(t);
      // Still really clear it — a recording-only stub would leak live timers
      // into the rest of this file.
      realClearInterval(t);
    }) as any);

    const { withPhase } = await import("../src/daemon/phase-telemetry.js");

    await withPhase(CTX, "scan", async () => {});
    await withPhase(CTX, "diff", async () => { throw new Error("boom"); }).catch(() => {});

    expect(unreffed).toHaveLength(2);
    expect(cleared).toHaveLength(2);
    // Every timer that was armed was also cleared.
    expect(cleared).toEqual(unreffed);
  });

  it("arms no timer at all when SCRYBE_PHASE_RSS_POLL_MS=0", async () => {
    process.env["SCRYBE_PHASE_RSS_POLL_MS"] = "0";
    const spy = vi.spyOn(globalThis, "setInterval");

    const { withPhase } = await import("../src/daemon/phase-telemetry.js");
    await withPhase(CTX, "scan", async () => {});

    expect(spy).not.toHaveBeenCalled();
    expect(readPhaseLog()).toHaveLength(1);
  });
});

describe("startSegmentedPhase", () => {
  it("emits a single final record when the phase is shorter than the segment window", async () => {
    process.env["SCRYBE_PHASE_SEGMENT_MS"] = "60000";
    const { startSegmentedPhase } = await import("../src/daemon/phase-telemetry.js");

    const p = startSegmentedPhase(CTX, "chunk_embed");
    p.addWork({ batches: 1, chunks_prepared: 10 });
    p.maybeRoll();
    p.addWork({ batches: 1, chunks_prepared: 5 });
    p.end();

    const records = readPhaseLog();
    expect(records).toHaveLength(1);
    expect(records[0]!.final).toBe(true);
    expect(records[0]!.seq).toBe(0);
    expect(records[0]!.work.batches).toBe(2);
    expect(records[0]!.work.chunks_prepared).toBe(15);
  });

  it("rolls interim records once the segment window elapses, resetting per-segment counters", async () => {
    process.env["SCRYBE_PHASE_SEGMENT_MS"] = "1";
    const { startSegmentedPhase } = await import("../src/daemon/phase-telemetry.js");

    const p = startSegmentedPhase(CTX, "chunk_embed");
    p.addWork({ batches: 1, chunks_prepared: 10 });
    await new Promise((r) => setTimeout(r, 5));
    p.maybeRoll();

    p.addWork({ batches: 1, chunks_prepared: 7 });
    await new Promise((r) => setTimeout(r, 5));
    p.maybeRoll();

    p.addWork({ batches: 1, chunks_prepared: 3 });
    p.end();

    const records = readPhaseLog();
    expect(records).toHaveLength(3);
    expect(records.map((r) => r.seq)).toEqual([0, 1, 2]);
    expect(records.map((r) => r.final)).toEqual([false, false, true]);
    // Counters are per-segment deltas, not cumulative.
    expect(records.map((r) => r.work.chunks_prepared)).toEqual([10, 7, 3]);
    // Each segment starts where the previous one ended, so segments chain.
    expect(records[1]!.startRssBytes).toBe(records[0]!.endRssBytes);
    expect(records[2]!.startRssBytes).toBe(records[1]!.endRssBytes);
  });

  it("carries setWork fields across segments while addWork counters reset", async () => {
    process.env["SCRYBE_PHASE_SEGMENT_MS"] = "1";
    const { startSegmentedPhase } = await import("../src/daemon/phase-telemetry.js");

    const p = startSegmentedPhase(CTX, "chunk_embed");
    p.setWork({ provider: "api", batch_size: 64 });
    p.addWork({ batches: 1 });
    await new Promise((r) => setTimeout(r, 5));
    p.maybeRoll();
    p.end();

    const records = readPhaseLog();
    expect(records).toHaveLength(2);
    for (const r of records) {
      expect(r.work.provider).toBe("api");
      expect(r.work.batch_size).toBe(64);
    }
    expect(records[0]!.work.batches).toBe(1);
    expect(records[1]!.work.batches).toBeUndefined();
  });

  it("end() is idempotent so an error path plus the happy path cannot double-emit", async () => {
    const { startSegmentedPhase } = await import("../src/daemon/phase-telemetry.js");

    const p = startSegmentedPhase(CTX, "chunk_embed");
    p.end("error");
    p.end("ok");
    p.maybeRoll();

    const records = readPhaseLog();
    expect(records).toHaveLength(1);
    expect(records[0]!.outcome).toBe("error");
  });

  it("never rolls when segmenting is disabled", async () => {
    process.env["SCRYBE_PHASE_SEGMENT_MS"] = "0";
    const { startSegmentedPhase } = await import("../src/daemon/phase-telemetry.js");

    const p = startSegmentedPhase(CTX, "chunk_embed");
    await new Promise((r) => setTimeout(r, 5));
    p.maybeRoll();
    p.maybeRoll();
    p.end();

    expect(readPhaseLog()).toHaveLength(1);
  });
});

describe("emitJobIntent", () => {
  it("records what the job was told to do, before and after the diff", async () => {
    const { emitJobIntent } = await import("../src/daemon/phase-telemetry.js");

    emitJobIntent(CTX, "started", { is_code: true });
    emitJobIntent(CTX, "planned", { files_total: 900, files_to_reindex: 0, files_to_remove: 0 });

    const records = readPhaseLog();
    expect(records.map((r) => r.stage)).toEqual(["started", "planned"]);
    expect(records.every((r) => r.event === "indexer.job.intent")).toBe(true);
    expect(records[0]!.jobId).toBe("job-1");
    expect(typeof records[0]!.rssBytes).toBe("number");
    // "scanned 900, processed 0" must be distinguishable from "no record written".
    expect(records[1]!.files_total).toBe(900);
    expect(records[1]!.files_to_reindex).toBe(0);
  });
});

describe("sink separation and volume", () => {
  it("writes to phase-log.jsonl and leaves daemon-log.jsonl untouched", async () => {
    const daemonLog = join(process.env["SCRYBE_DATA_DIR"]!, "daemon-log.jsonl");
    process.env["SCRYBE_DAEMON_LOG_PATH"] = daemonLog;

    const { withPhase } = await import("../src/daemon/phase-telemetry.js");
    await withPhase(CTX, "scan", async () => {});

    expect(readPhaseLog()).toHaveLength(1);
    expect(existsSync(daemonLog)).toBe(false);

    delete process.env["SCRYBE_DAEMON_LOG_PATH"];
  });

  it("honours SCRYBE_PHASE_LOG_PATH", async () => {
    const custom = join(process.env["SCRYBE_DATA_DIR"]!, "custom-phases.jsonl");
    process.env["SCRYBE_PHASE_LOG_PATH"] = custom;

    const { withPhase } = await import("../src/daemon/phase-telemetry.js");
    await withPhase(CTX, "scan", async () => {});

    expect(readPhaseLog(custom)).toHaveLength(1);
    expect(existsSync(PHASE_LOG())).toBe(false);
  });

  it("rotates its own sink at its own threshold, independent of the daemon log", async () => {
    process.env["SCRYBE_PHASE_LOG_MAX_BYTES"] = "64";

    const path = PHASE_LOG();
    writeFileSync(path, "x".repeat(200) + "\n", "utf8");

    const { withPhase } = await import("../src/daemon/phase-telemetry.js");
    await withPhase(CTX, "scan", async () => {});

    // Oversized file moved aside; the new record starts a fresh log.
    expect(existsSync(`${path}.1`)).toBe(true);
    expect(readPhaseLog()).toHaveLength(1);
  });

  it("writes nothing when SCRYBE_PHASE_TELEMETRY=0", async () => {
    process.env["SCRYBE_PHASE_TELEMETRY"] = "0";

    const { withPhase, startSegmentedPhase, emitJobIntent } = await import("../src/daemon/phase-telemetry.js");
    emitJobIntent(CTX, "started");
    await withPhase(CTX, "scan", async () => {});
    startSegmentedPhase(CTX, "chunk_embed").end();

    expect(existsSync(PHASE_LOG())).toBe(false);
  });
});

describe("log-rotate — per-sink thresholds", () => {
  it("uses the caller's maxBytes and backup count without touching the defaults", async () => {
    const { rotateIfNeeded } = await import("../src/daemon/log-rotate.js");
    const path = join(process.env["SCRYBE_DATA_DIR"]!, "tiny.jsonl");

    writeFileSync(path, "a".repeat(50), "utf8");
    rotateIfNeeded(path, 1024, 1);
    expect(existsSync(`${path}.1`)).toBe(false); // under threshold

    writeFileSync(path, "a".repeat(2048), "utf8");
    rotateIfNeeded(path, 1024, 1);
    expect(existsSync(`${path}.1`)).toBe(true);
    expect(existsSync(path)).toBe(false);
  });
});
