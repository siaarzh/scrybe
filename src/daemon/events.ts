import { appendFileSync } from "node:fs";
import { join } from "node:path";
import { config } from "../config.js";

function logPath(): string {
  return process.env["SCRYBE_DAEMON_LOG_PATH"] ?? join(config.dataDir, "daemon-log.jsonl");
}

function debugEnabled(): boolean {
  return process.env["SCRYBE_DEBUG_INDEXER"] === "1";
}

/**
 * This process's pid, cached once at module init (Plan 109 Phase 1). Stamped
 * onto every record `diagEmit` writes so any line in daemon-log.jsonl can be
 * attributed to a specific daemon process — `process.pid` never changes for
 * the life of the process, so there is no benefit to re-reading it per call.
 */
const _pid = process.pid;

/**
 * Emit a structured event to daemon-log.jsonl.
 *
 * Volume policy (Decision 9):
 *   - indexer.scan.completed         — always written to daemon log
 *   - indexer.embed.batch            — only when SCRYBE_DEBUG_INDEXER=1
 *   - indexer.write.completed        — only when SCRYBE_DEBUG_INDEXER=1
 *   - indexer.flush.intra_batch_dedup — always written (regression signal; should never fire under scheme-2)
 *   - indexer.job.summary            — always written to daemon log
 *   - process.uncaughtException / process.unhandledRejection — always written
 */
export function diagEmit(record: Record<string, unknown>): void {
  const event = record["event"] as string | undefined;

  const highVolume =
    event === "indexer.embed.batch" || event === "indexer.write.completed";

  if (highVolume && !debugEnabled()) return;

  try {
    appendFileSync(
      logPath(),
      JSON.stringify({ ts: new Date().toISOString(), pid: _pid, ...record }) + "\n",
      "utf8",
    );
  } catch { /* non-fatal */ }
}
