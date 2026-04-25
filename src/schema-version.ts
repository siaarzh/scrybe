import {
  readFileSync,
  writeFileSync,
  existsSync,
  readdirSync,
  unlinkSync,
  mkdirSync,
} from "fs";
import { join } from "path";
import { config } from "./config.js";
import { closeDB } from "./branch-state.js";

export const CURRENT_SCHEMA_VERSION = 2;

function schemaFilePath(): string {
  return join(config.dataDir, "schema.json");
}

function hashesDir(): string {
  return join(config.dataDir, "hashes");
}

function branchTagsDbPath(): string {
  return join(config.dataDir, "branch-tags.db");
}

function readVersion(): number {
  const p = schemaFilePath();
  if (!existsSync(p)) return 1;
  try {
    const raw = JSON.parse(readFileSync(p, "utf8")) as { version?: number };
    return typeof raw.version === "number" ? raw.version : 1;
  } catch {
    return 1;
  }
}

function writeVersion(v: number): void {
  mkdirSync(join(config.dataDir), { recursive: true });
  writeFileSync(schemaFilePath(), JSON.stringify({ version: v }, null, 2), "utf8");
}

export function checkAndMigrate(): { migrated: boolean; version: number } {
  const current = readVersion();

  if (current >= CURRENT_SCHEMA_VERSION) {
    return { migrated: false, version: current };
  }

  if (process.env.SCRYBE_SKIP_MIGRATION === "1") {
    console.error(
      "[scrybe] SCRYBE_SKIP_MIGRATION=1: running in read-only compatibility mode. " +
      "Branch features are disabled. Run without SCRYBE_SKIP_MIGRATION and re-index to upgrade."
    );
    return { migrated: false, version: current };
  }

  console.error(
    `\n[scrybe] Upgrading index to branch-aware format (v${CURRENT_SCHEMA_VERSION}).` +
    "\nThis is a one-time full reindex — all projects will be re-embedded on next index run." +
    "\nTo skip and run read-only: set SCRYBE_SKIP_MIGRATION=1.\n"
  );

  // Delete hash files → forces full reindex on next index command
  const hashes = hashesDir();
  if (existsSync(hashes)) {
    for (const f of readdirSync(hashes)) {
      try { unlinkSync(join(hashes, f)); } catch { /* ignore ENOENT races */ }
    }
  }

  // Close and delete branch-tags.db → fresh start
  closeDB();
  const dbPath = branchTagsDbPath();
  if (existsSync(dbPath)) {
    try { unlinkSync(dbPath); } catch { /* ignore */ }
  }

  writeVersion(CURRENT_SCHEMA_VERSION);
  return { migrated: true, version: CURRENT_SCHEMA_VERSION };
}
