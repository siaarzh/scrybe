import { existsSync, statSync, renameSync, unlinkSync } from "fs";

const MAX_BYTES = parseInt(process.env["SCRYBE_DAEMON_LOG_MAX_BYTES"] ?? String(10 * 1024 * 1024), 10);
const BACKUPS   = parseInt(process.env["SCRYBE_DAEMON_LOG_BACKUPS"] ?? "3", 10);

/**
 * Rotates `logPath` if it exceeds MAX_BYTES.
 * Keeps up to BACKUPS numbered copies (.1 = newest, .N = oldest).
 * Best-effort: silently swallows filesystem errors.
 */
export function rotateIfNeeded(logPath: string): void {
  if (!existsSync(logPath)) return;
  try {
    if (statSync(logPath).size < MAX_BYTES) return;

    // Drop oldest backup
    const oldest = `${logPath}.${BACKUPS}`;
    if (existsSync(oldest)) unlinkSync(oldest);

    // Shift .1 → .2, .2 → .3, …
    for (let i = BACKUPS - 1; i >= 1; i--) {
      const from = `${logPath}.${i}`;
      if (existsSync(from)) renameSync(from, `${logPath}.${i + 1}`);
    }

    renameSync(logPath, `${logPath}.1`);
  } catch { /* best-effort */ }
}
