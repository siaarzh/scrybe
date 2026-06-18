#!/usr/bin/env node
/**
 * correlate-crashes.mjs — host-side correlation join
 *
 * Time-joins scrybe's daemon-log.jsonl (mem-sample + activity-span records)
 * against pocketmux's crashes.json (crashed_at timestamps) to reveal whether
 * scrybe RSS spikes / active reindexes cluster around session deaths.
 *
 * Usage:
 *   node tools/correlate-crashes.mjs [options]
 *
 * Options:
 *   --scrybe-log <path>       Path to daemon-log.jsonl
 *                             Default: $SCRYBE_DAEMON_LOG_PATH or
 *                             $XDG_DATA_HOME/scrybe/daemon-log.jsonl or
 *                             ~/.local/share/scrybe/daemon-log.jsonl
 *   --crashes <path>          Path to pocketmux crashes.json
 *                             Default: ~/.local/state/pocketmux/crashes.json
 *   --window-seconds <n>      Correlation window in seconds (default: 120)
 *   --self-test               Run against embedded fixture data and exit 0/1
 *
 * Output:
 *   Per-crash correlation table — crash time, session name/project,
 *   nearest scrybe RSS sample in MB, active span (if any), and the delta
 *   between the crash and the nearest sample.
 *
 * This script ONLY reads both ledgers — it never writes anything and imports
 * no scrybe daemon internals or pocketmux internals. Decoupled by design
 * (scrybe Plan 92, D2).
 *
 * Record shapes consumed from daemon-log.jsonl:
 *   mem-sample:    { ts, event: "mem-sample", rssBytes, heapUsedBytes, ... }
 *   activity-span: { ts, event: "activity-span", spanType, startRssBytes,
 *                    peakRssBytes, endRssBytes, provider, outcome, durationMs,
 *                    startTs?, endTs? }
 *
 * crashes.json shape (pocketmux state_store.py):
 *   { uuid: { name, project, label, preset, crashed_at,
 *             ended_at?,   // optional — added by future pmux sibling task
 *             reason? } }  // optional — ditto
 */

import { readFileSync, existsSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

// ─── Defaults ──────────────────────────────────────────────────────────────

function defaultScrybeLog() {
  if (process.env["SCRYBE_DAEMON_LOG_PATH"]) {
    return process.env["SCRYBE_DAEMON_LOG_PATH"];
  }
  const xdgData = process.env["XDG_DATA_HOME"] ?? join(homedir(), ".local", "share");
  return join(xdgData, "scrybe", "daemon-log.jsonl");
}

function defaultCrashesJson() {
  return join(homedir(), ".local", "state", "pocketmux", "crashes.json");
}

// ─── Arg parsing ───────────────────────────────────────────────────────────

function parseArgs(argv) {
  const args = {
    scrybeLog: defaultScrybeLog(),
    crashesPath: defaultCrashesJson(),
    windowSeconds: 120,
    selfTest: false,
  };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--scrybe-log") args.scrybeLog = argv[++i];
    else if (a === "--crashes") args.crashesPath = argv[++i];
    else if (a === "--window-seconds") args.windowSeconds = Number(argv[++i]);
    else if (a === "--self-test") args.selfTest = true;
    else if (a === "--help" || a === "-h") {
      console.log("Usage: node tools/correlate-crashes.mjs [--scrybe-log <path>] [--crashes <path>] [--window-seconds <n>] [--self-test]");
      process.exit(0);
    }
  }
  return args;
}

// ─── Loader helpers ─────────────────────────────────────────────────────────

/** Read daemon-log.jsonl, return array of parsed records (skip malformed lines). */
function loadDaemonLog(path) {
  if (!existsSync(path)) return null;
  const text = readFileSync(path, "utf8");
  const records = [];
  for (const line of text.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    try {
      records.push(JSON.parse(trimmed));
    } catch {
      // skip malformed lines
    }
  }
  return records;
}

/** Read crashes.json. Returns null if file missing, {} if empty/malformed. */
function loadCrashes(path) {
  if (!existsSync(path)) return null;
  try {
    const text = readFileSync(path, "utf8");
    const data = JSON.parse(text);
    if (typeof data !== "object" || Array.isArray(data) || data === null) return {};
    return data;
  } catch {
    return {};
  }
}

// ─── Core correlation logic ─────────────────────────────────────────────────

/**
 * @typedef {{ ts: string, event: string, rssBytes?: number, [k: string]: unknown }} DaemonRecord
 * @typedef {{ uuid: string, name: string, project: string, label?: string, preset?: string | null, crashed_at: number, ended_at?: number, reason?: string }} CrashEntry
 */

/**
 * Extract mem-sample records from daemon log and return sorted by epoch ms.
 * @param {DaemonRecord[]} records
 * @returns {{ epochMs: number, rssBytes: number }[]}
 */
function extractMemSamples(records) {
  return records
    .filter((r) => r["event"] === "mem-sample" && typeof r["rssBytes"] === "number")
    .map((r) => ({ epochMs: new Date(/** @type {string} */ (r["ts"])).getTime(), rssBytes: /** @type {number} */ (r["rssBytes"]) }))
    .filter((s) => !isNaN(s.epochMs))
    .sort((a, b) => a.epochMs - b.epochMs);
}

/**
 * Extract activity-span records from daemon log.
 * @param {DaemonRecord[]} records
 * @returns {{ startMs: number, endMs: number, spanType: string, provider: string|null, outcome: string, peakRssBytes: number|null }[]}
 */
function extractActivitySpans(records) {
  return records
    .filter((r) => r["event"] === "activity-span")
    .map((r) => {
      const tsMs = new Date(/** @type {string} */ (r["ts"])).getTime();
      const durationMs = typeof r["durationMs"] === "number" ? r["durationMs"] : 0;
      // ts is the end time (emitted on span close); startTs may be present
      const endMs = isNaN(tsMs) ? 0 : tsMs;
      let startMs;
      if (typeof r["startTs"] === "string") {
        startMs = new Date(r["startTs"]).getTime();
      } else {
        startMs = endMs - durationMs;
      }
      return {
        startMs,
        endMs,
        spanType: String(r["spanType"] ?? "unknown"),
        provider: r["provider"] != null ? String(r["provider"]) : null,
        outcome: String(r["outcome"] ?? "unknown"),
        peakRssBytes: typeof r["peakRssBytes"] === "number" ? r["peakRssBytes"] : null,
      };
    })
    .filter((s) => !isNaN(s.startMs) && !isNaN(s.endMs));
}

/**
 * Find the nearest mem-sample to a crash epoch (within windowMs).
 * Returns null if none found within the window.
 * @param {{ epochMs: number, rssBytes: number }[]} samples
 * @param {number} crashEpochMs
 * @param {number} windowMs
 */
function nearestSample(samples, crashEpochMs, windowMs) {
  let best = null;
  let bestDeltaMs = Infinity;
  for (const s of samples) {
    const delta = Math.abs(s.epochMs - crashEpochMs);
    if (delta <= windowMs && delta < bestDeltaMs) {
      bestDeltaMs = delta;
      best = { ...s, deltaMs: delta };
    }
  }
  return best;
}

/**
 * Find activity spans that were active at the crash moment (startMs <= crash <= endMs).
 * Also include spans that start or end within the window.
 * @param {{ startMs: number, endMs: number, spanType: string, provider: string|null, outcome: string, peakRssBytes: number|null }[]} spans
 * @param {number} crashEpochMs
 * @param {number} windowMs
 */
function activeSpans(spans, crashEpochMs, windowMs) {
  return spans.filter(
    (s) =>
      // span straddles the crash moment
      (s.startMs <= crashEpochMs && s.endMs >= crashEpochMs) ||
      // span starts within window before/after crash
      (Math.abs(s.startMs - crashEpochMs) <= windowMs) ||
      // span ends within window before/after crash
      (Math.abs(s.endMs - crashEpochMs) <= windowMs),
  );
}

// ─── Formatting ─────────────────────────────────────────────────────────────

const MB = 1024 * 1024;

function fmtRss(bytes) {
  return (bytes / MB).toFixed(1) + " MB";
}

function fmtTime(epochMs) {
  return new Date(epochMs).toISOString().replace("T", " ").slice(0, 19) + " UTC";
}

function fmtDelta(ms) {
  const s = Math.round(ms / 1000);
  return s + "s";
}

// ─── Main correlation ───────────────────────────────────────────────────────

/**
 * Run the correlation join.
 * @param {{ epochMs: number, rssBytes: number }[]} memSamples
 * @param {{ startMs: number, endMs: number, spanType: string, provider: string|null, outcome: string, peakRssBytes: number|null }[]} spans
 * @param {{ uuid: string, name: string, project: string, label?: string, preset?: string | null, crashed_at: number, ended_at?: number, reason?: string }[]} crashes
 * @param {number} windowMs
 * @returns {{ printed: number, rows: object[] }}
 */
function correlate(memSamples, spans, crashes, windowMs) {
  if (crashes.length === 0) {
    console.log("No crashes to correlate.");
    return { printed: 0, rows: [] };
  }
  if (memSamples.length === 0 && spans.length === 0) {
    console.log("No scrybe telemetry found (no mem-samples or activity-spans in daemon log).");
    console.log("Crash count:", crashes.length);
    console.log("Start scrybe daemon to begin collecting telemetry.");
    return { printed: 0, rows: [] };
  }

  const sortedCrashes = [...crashes].sort((a, b) => a.crashed_at - b.crashed_at);

  const rows = [];

  for (const crash of sortedCrashes) {
    const crashMs = crash.crashed_at * 1000;
    const nearest = nearestSample(memSamples, crashMs, windowMs);
    const active = activeSpans(spans, crashMs, windowMs);

    // Build active-span summary
    let spanSummary = "none";
    if (active.length > 0) {
      spanSummary = active
        .map((s) => {
          const peak = s.peakRssBytes != null ? " (peak " + fmtRss(s.peakRssBytes) + ")" : "";
          const prov = s.provider ? " [" + s.provider + "]" : "";
          return s.spanType + prov + peak;
        })
        .join(", ");
    }

    const row = {
      crashTime: fmtTime(crashMs),
      name: crash.name,
      project: crash.project,
      reason: crash.reason ?? "unknown",
      nearestRss: nearest ? fmtRss(nearest.rssBytes) : "n/a",
      deltaSeconds: nearest ? fmtDelta(nearest.deltaMs) : "n/a",
      activeSpans: spanSummary,
    };
    rows.push(row);
  }

  // Print table
  const COL_W = [20, 20, 20, 10, 12, 8, 40];
  const headers = ["Crash Time (UTC)", "Session Name", "Project", "Reason", "Nearest RSS", "Delta", "Active Spans"];
  const divider = headers.map((_, i) => "-".repeat(COL_W[i])).join("-+-");

  console.log("\n=== Scrybe / pocketmux crash correlation ===");
  console.log(`Window: ±${windowMs / 1000}s | Crashes: ${sortedCrashes.length} | Mem samples: ${memSamples.length} | Activity spans: ${spans.length}\n`);
  console.log(headers.map((h, i) => h.padEnd(COL_W[i])).join(" | "));
  console.log(divider);

  for (const row of rows) {
    const cells = [
      row.crashTime,
      row.name,
      row.project,
      row.reason,
      row.nearestRss,
      row.deltaSeconds,
      row.activeSpans,
    ];
    console.log(cells.map((c, i) => String(c).padEnd(COL_W[i])).join(" | "));
  }
  console.log("");

  return { printed: rows.length, rows };
}

// ─── Self-test ──────────────────────────────────────────────────────────────

/**
 * Run a self-test with embedded fixture data. Exits 0 on pass, 1 on fail.
 */
function runSelfTest() {
  console.log("Running self-test with embedded fixture data...\n");

  // Base epoch: 2026-01-01T10:00:00Z = 1767225600000 ms
  const BASE = 1767225600000;
  const sec = (n) => BASE + n * 1000;

  // mem-sample records emitted by diagEmit: ts=ISO, event, rssBytes, ...
  const daemonRecords = [
    // samples at t=0, t=60, t=120, t=180, t=240
    { ts: new Date(sec(0)).toISOString(), event: "mem-sample", rssBytes: 500 * MB, heapUsedBytes: 200 * MB, heapTotalBytes: 300 * MB, externalBytes: 10 * MB },
    { ts: new Date(sec(60)).toISOString(), event: "mem-sample", rssBytes: 800 * MB, heapUsedBytes: 350 * MB, heapTotalBytes: 400 * MB, externalBytes: 12 * MB },
    { ts: new Date(sec(120)).toISOString(), event: "mem-sample", rssBytes: 1500 * MB, heapUsedBytes: 600 * MB, heapTotalBytes: 700 * MB, externalBytes: 15 * MB },
    { ts: new Date(sec(180)).toISOString(), event: "mem-sample", rssBytes: 1600 * MB, heapUsedBytes: 620 * MB, heapTotalBytes: 720 * MB, externalBytes: 16 * MB },
    { ts: new Date(sec(240)).toISOString(), event: "mem-sample", rssBytes: 900 * MB, heapUsedBytes: 400 * MB, heapTotalBytes: 500 * MB, externalBytes: 11 * MB },
    // a sample well outside the window for any crash (t=1000)
    { ts: new Date(sec(1000)).toISOString(), event: "mem-sample", rssBytes: 300 * MB, heapUsedBytes: 100 * MB, heapTotalBytes: 200 * MB, externalBytes: 5 * MB },

    // activity-span: reindex running t=90..t=160
    {
      ts: new Date(sec(160)).toISOString(), // endMs = t=160
      event: "activity-span",
      spanType: "reindex",
      startTs: new Date(sec(90)).toISOString(),
      durationMs: 70000,
      provider: "local",
      outcome: "success",
      startRssBytes: 800 * MB,
      peakRssBytes: 1550 * MB,
      endRssBytes: 1500 * MB,
    },
    // activity-span: mcp-call at t=200..t=202
    {
      ts: new Date(sec(202)).toISOString(),
      event: "activity-span",
      spanType: "mcp-call",
      startTs: new Date(sec(200)).toISOString(),
      durationMs: 2000,
      provider: "local",
      outcome: "success",
      startRssBytes: 1600 * MB,
      peakRssBytes: 1620 * MB,
      endRssBytes: 1610 * MB,
    },
    // an unrelated record type — should be ignored
    { ts: new Date(sec(50)).toISOString(), event: "indexer.job.summary", chunks: 42 },
  ];

  // crashes.json entries
  // crash A: t=125 — mid-reindex, high RSS (1500 MB at t=120)
  // crash B: t=500 — no mem-sample within 120s window (nearest is t=240, delta=260s)
  // crash C: t=198 — mcp-call span active, sample at t=180 is 60s away (within window), t=240 closer = 42s
  const crashEntries = [
    { uuid: "aaa", name: "session-alpha", project: "cmx-core", label: "lbl-a", preset: null, crashed_at: BASE / 1000 + 125 },
    { uuid: "bbb", name: "session-beta", project: "cmx-ionic", label: "lbl-b", preset: "standup", crashed_at: BASE / 1000 + 500 },
    { uuid: "ccc", name: "session-gamma", project: "scrybe", label: "lbl-c", preset: null, crashed_at: BASE / 1000 + 198,
      ended_at: BASE / 1000 + 200, reason: "external-teardown" }, // optional future fields
  ];

  const memSamples = extractMemSamples(daemonRecords);
  const spans = extractActivitySpans(daemonRecords);

  // Assertions
  let pass = true;
  const assert = (cond, msg) => {
    if (!cond) {
      console.error("  FAIL:", msg);
      pass = false;
    } else {
      console.log("  PASS:", msg);
    }
  };

  assert(memSamples.length === 6, `extracted 6 mem-samples (got ${memSamples.length})`);
  assert(spans.length === 2, `extracted 2 activity-spans (got ${spans.length})`);

  // Crash A: t=125. Nearest sample should be t=120 (5s delta, 1500 MB)
  const nA = nearestSample(memSamples, BASE + 125 * 1000, 120 * 1000);
  assert(nA !== null, "crash A has a nearest sample");
  assert(nA !== null && Math.abs(nA.deltaMs - 5000) < 100, `crash A nearest delta ~5s (got ${nA?.deltaMs}ms)`);
  assert(nA !== null && Math.abs(nA.rssBytes - 1500 * MB) < 1024, `crash A nearest RSS = 1500 MB (got ${nA?.rssBytes})`);

  // Crash A: reindex span should be active (span is t=90..160, crash is t=125)
  const spA = activeSpans(spans, BASE + 125 * 1000, 120 * 1000);
  assert(spA.some((s) => s.spanType === "reindex"), "crash A has active reindex span");

  // Crash B: t=500. Nearest sample is t=240 (delta=260s > 120s window) → no match
  const nB = nearestSample(memSamples, BASE + 500 * 1000, 120 * 1000);
  assert(nB === null, "crash B has no nearest sample within 120s window (got null)");

  // Crash C: t=198. Nearest sample — t=180 (18s delta, 1600 MB) or t=240 (42s). t=180 is closer.
  const nC = nearestSample(memSamples, BASE + 198 * 1000, 120 * 1000);
  assert(nC !== null, "crash C has a nearest sample");
  assert(nC !== null && Math.abs(nC.deltaMs - 18000) < 100, `crash C nearest delta ~18s (got ${nC?.deltaMs}ms)`);
  assert(nC !== null && Math.abs(nC.rssBytes - 1600 * MB) < 1024, `crash C nearest RSS = 1600 MB (got ${nC?.rssBytes})`);

  // Crash C: optional ended_at/reason handled gracefully
  assert(crashEntries[2].reason === "external-teardown", "crash C has optional reason field");
  assert(typeof crashEntries[2].ended_at === "number", "crash C has optional ended_at field");

  // Full correlate run (visual output, non-crashing)
  console.log("\n--- Full correlate() output (fixture) ---");
  const { printed, rows } = correlate(memSamples, spans, crashEntries, 120 * 1000);
  // sorted by crashed_at: A (t+125), C (t+198), B (t+500)
  assert(printed === 3, `correlate printed 3 rows (got ${printed})`);
  assert(rows[0].activeSpans.includes("reindex"), "crash A row (index 0) shows active reindex span");
  assert(rows[1].reason === "external-teardown", "crash C row (index 1) shows reason from optional field");
  assert(rows[2].nearestRss === "n/a", "crash B row (index 2) shows n/a for nearest RSS (out of window)");

  console.log("\n" + (pass ? "Self-test PASSED" : "Self-test FAILED"));
  process.exit(pass ? 0 : 1);
}

// ─── Entry point ───────────────────────────────────────────────────────────

const args = parseArgs(process.argv.slice(2));

if (args.selfTest) {
  runSelfTest();
  // runSelfTest() exits
}

// Load scrybe daemon log
const daemonRecords = loadDaemonLog(args.scrybeLog);
if (daemonRecords === null) {
  console.log(`Scrybe daemon log not found: ${args.scrybeLog}`);
  console.log("Start the scrybe daemon to begin collecting telemetry.");
  process.exit(0);
}

// Load pocketmux crashes
const crashMap = loadCrashes(args.crashesPath);
if (crashMap === null) {
  console.log(`pocketmux crashes.json not found: ${args.crashesPath}`);
  console.log("No crashed sessions to correlate against.");
  process.exit(0);
}

const memSamples = extractMemSamples(daemonRecords);
const spans = extractActivitySpans(daemonRecords);

// Flatten crashes map to array, gracefully handling optional ended_at/reason
const crashes = Object.entries(crashMap).map(([uuid, entry]) => ({
  uuid,
  name: String(entry.name ?? uuid),
  project: String(entry.project ?? ""),
  label: entry.label != null ? String(entry.label) : undefined,
  preset: entry.preset ?? null,
  crashed_at: Number(entry.crashed_at),
  // optional future fields — handle gracefully if present
  ended_at: entry.ended_at != null ? Number(entry.ended_at) : undefined,
  reason: entry.reason != null ? String(entry.reason) : undefined,
}));

correlate(memSamples, spans, crashes, args.windowSeconds * 1000);
