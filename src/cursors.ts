import { join } from "path";
import { mkdirSync, readFileSync, writeFileSync, existsSync, rmSync } from "fs";
import { config } from "./config.js";

const CURSORS_DIR = join(config.dataDir, "cursors");

function cursorPath(projectId: string, sourceId: string): string {
  return join(CURSORS_DIR, `${projectId}__${sourceId}.json`);
}

export function loadCursor(projectId: string, sourceId: string): string | null {
  const p = cursorPath(projectId, sourceId);
  if (!existsSync(p)) return null;
  try {
    const data = JSON.parse(readFileSync(p, "utf8")) as { updated_after?: string };
    return data.updated_after ?? null;
  } catch {
    return null;
  }
}

export function saveCursor(projectId: string, sourceId: string, value: string): void {
  mkdirSync(CURSORS_DIR, { recursive: true });
  writeFileSync(cursorPath(projectId, sourceId), JSON.stringify({ updated_after: value }), "utf8");
}

export function deleteCursor(projectId: string, sourceId: string): void {
  const p = cursorPath(projectId, sourceId);
  if (existsSync(p)) rmSync(p);
}
