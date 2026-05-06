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
 * Emit a structured event to daemon-log.jsonl.
 *
 * Volume policy (Decision 9):
 *   - indexer.scan.completed  — always written to daemon log
 *   - indexer.embed.batch     — only when SCRYBE_DEBUG_INDEXER=1
 *   - indexer.write.completed — only when SCRYBE_DEBUG_INDEXER=1
 *   - indexer.job.summary     — always written to daemon log
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
      JSON.stringify({ ts: new Date().toISOString(), ...record }) + "\n",
      "utf8",
    );
  } catch { /* non-fatal */ }
}
