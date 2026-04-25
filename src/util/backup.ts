import { copyFileSync, existsSync } from "fs";

/** Copies path to <path>.scrybe-backup-<epoch-seconds>. Returns backup path. */
export function createBackup(path: string): string {
  if (!existsSync(path)) throw new Error(`Cannot back up missing file: ${path}`);
  const backup = `${path}.scrybe-backup-${Math.floor(Date.now() / 1000)}`;
  copyFileSync(path, backup);
  return backup;
}
