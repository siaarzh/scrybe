import { writeFileSync, unlinkSync, mkdtempSync, rmdirSync } from "fs";
import { join } from "path";
import { tmpdir } from "os";
import { spawnSync } from "child_process";
import { writeLauncherScript, MARKER_CRON_COMMENT } from "./shared.js";
import type { InstallStatus, InstallMethod } from "./index.js";

export async function install(): Promise<InstallStatus> {
  const launcher = writeLauncherScript();
  const entry = `@reboot ${launcher} ${MARKER_CRON_COMMENT}`;

  const existing = readCrontab();
  if (existing.includes(MARKER_CRON_COMMENT)) {
    // Update the managed line in place
    const updated = existing.split("\n")
      .map((l) => l.includes(MARKER_CRON_COMMENT) ? entry : l)
      .join("\n");
    writeCrontab(updated);
  } else {
    writeCrontab(existing.trimEnd() + "\n" + entry + "\n");
  }

  return { installed: true, method: "linux-cron", detail: { cronEntry: entry } };
}

export async function uninstall(): Promise<{ removed: boolean; method?: InstallMethod }> {
  const existing = readCrontab();
  if (!existing.includes(MARKER_CRON_COMMENT)) return { removed: false };

  const updated = existing.split("\n")
    .filter((l) => !l.includes(MARKER_CRON_COMMENT))
    .join("\n");
  writeCrontab(updated);
  return { removed: true, method: "linux-cron" };
}

export async function getStatus(): Promise<InstallStatus> {
  const existing = readCrontab();
  if (!existing.includes(MARKER_CRON_COMMENT)) return { installed: false };
  const line = existing.split("\n").find((l) => l.includes(MARKER_CRON_COMMENT));
  return { installed: true, method: "linux-cron", detail: { cronEntry: line } };
}

function readCrontab(): string {
  const r = spawnSync("crontab", ["-l"], { encoding: "utf8", timeout: 5_000 });
  if (r.status === 0) return r.stdout ?? "";
  return ""; // no crontab or error — start fresh
}

function writeCrontab(content: string): void {
  const dir  = mkdtempSync(join(tmpdir(), "scrybe-cron-"));
  const file = join(dir, "crontab");
  try {
    writeFileSync(file, content, "utf8");
    const r = spawnSync("crontab", [file], { encoding: "utf8", timeout: 5_000 });
    if (r.status !== 0) throw new Error(`crontab write failed: ${r.stderr?.trim()}`);
  } finally {
    try { unlinkSync(file); } catch { /* ignore */ }
    try { rmdirSync(dir); } catch { /* ignore */ }
  }
}
