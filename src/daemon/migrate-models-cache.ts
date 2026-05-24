/**
 * Best-effort migration: move the old in-package @xenova/transformers model cache
 * (.cache/Xenova/) to ${DATA_DIR}/models/Xenova/ on first daemon start.
 *
 * The new location is set by getTransformers() (src/util/transformers-loader.ts)
 * so models downloaded after this migration land there permanently.
 *
 * Called once at daemon startup (after config.dataDir is known, before first
 * pipeline load). Absent old cache is a silent no-op.
 *
 * Design note: pass paths as params with defaults so tests can inject temp dirs
 * without touching the real filesystem.
 */

import { existsSync } from "fs";
import { rename, cp, rm } from "fs/promises";
import { join, dirname } from "path";
import { createRequire } from "node:module";

/**
 * Resolve the old in-package cache path.
 * @xenova/transformers defaults to path.join(__dirname, '/.cache/') inside its package.
 * We resolve from our import.meta.url so it tracks whichever install this process loaded.
 */
function resolveOldXenovaDir(): string | null {
  try {
    const req = createRequire(import.meta.url);
    const pkgJson = req.resolve("@xenova/transformers/package.json");
    return join(dirname(pkgJson), ".cache", "Xenova");
  } catch {
    return null;
  }
}

/**
 * Move old in-package model cache to DATA_DIR/models/Xenova/.
 *
 * @param _dataDir       - kept for call-site stability; destination now comes from
 *                         resolveModelCacheDir() so SCRYBE_MODEL_CACHE_DIR is honored
 * @param log            - logger function (e.g. daemonLog)
 * @param oldDirOverride - override old dir path for tests; defaults to resolveOldXenovaDir()
 * @param newDirOverride - override new dir path for tests; defaults to join(resolveModelCacheDir(), "Xenova")
 */
export async function migrateModelsCache(
  _dataDir: string,
  log: (msg: string) => void,
  oldDirOverride?: string,
  newDirOverride?: string
): Promise<void> {
  const oldDir = oldDirOverride ?? resolveOldXenovaDir();
  if (!oldDir) {
    // Could not resolve @xenova/transformers package — skip silently
    return;
  }

  // Destination must match where getTransformers() will look (honors
  // SCRYBE_MODEL_CACHE_DIR), so a migrated cache is actually found.
  const { resolveModelCacheDir } = await import("../util/transformers-loader.js");
  const newDir = newDirOverride ?? join(resolveModelCacheDir(), "Xenova");

  if (!existsSync(oldDir)) {
    // Old cache absent (npx-wipe case) — skip silently; pinning guarantees correctness.
    return;
  }

  if (existsSync(newDir)) {
    // Already migrated (or user pre-populated the new location) — skip.
    log("[scrybe] migrate-models-cache: destination already exists, skipping");
    return;
  }

  // Attempt atomic rename (fails across devices/filesystems)
  try {
    await rename(oldDir, newDir);
    log(`[scrybe] migrate-models-cache: moved ${oldDir} → ${newDir}`);
    return;
  } catch {
    // rename failed (EXDEV cross-device) — fall back to recursive copy + rm
  }

  try {
    await cp(oldDir, newDir, { recursive: true });
    await rm(oldDir, { recursive: true, force: true });
    log(`[scrybe] migrate-models-cache: copied ${oldDir} → ${newDir} (cross-device)`);
  } catch (e) {
    // Non-fatal — pinning will work on next model load; old cache stays where it is.
    log(`[scrybe] migrate-models-cache: failed to move cache (non-fatal): ${e}`);
  }
}
