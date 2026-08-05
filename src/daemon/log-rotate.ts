import { existsSync, statSync, renameSync, unlinkSync } from "fs";

const MAX_BYTES = parseInt(process.env["SCRYBE_DAEMON_LOG_MAX_BYTES"] ?? String(10 * 1024 * 1024), 10);
const BACKUPS   = parseInt(process.env["SCRYBE_DAEMON_LOG_BACKUPS"] ?? "3", 10);

/**
 * Rotates `logPath` if it exceeds `maxBytes` (default MAX_BYTES).
 * Keeps up to `backups` numbered copies (.1 = newest, .N = oldest).
 * Best-effort: silently swallows filesystem errors.
 *
 * The two optional arguments exist so a sink with its own retention budget
 * (e.g. the per-phase memory log) can reuse this rotation without inheriting
 * the daemon log's thresholds.
 */
export function rotateIfNeeded(logPath: string, maxBytes: number = MAX_BYTES, backups: number = BACKUPS): void {
  if (!existsSync(logPath)) return;
  try {
    if (statSync(logPath).size < maxBytes) return;

    // Drop oldest backup
    const oldest = `${logPath}.${backups}`;
    if (existsSync(oldest)) unlinkSync(oldest);

    // Shift .1 → .2, .2 → .3, …
    for (let i = backups - 1; i >= 1; i--) {
      const from = `${logPath}.${i}`;
      if (existsSync(from)) renameSync(from, `${logPath}.${i + 1}`);
    }

    renameSync(logPath, `${logPath}.1`);
  } catch { /* best-effort */ }
}
