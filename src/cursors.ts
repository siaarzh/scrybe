import { join } from "path";
import { mkdirSync, readFileSync, writeFileSync, existsSync, rmSync } from "fs";
import { config } from "./config.js";

const CURSORS_DIR = join(config.dataDir, "cursors");

function cursorPath(projectId: string): string {
  return join(CURSORS_DIR, `${projectId}.json`);
}

export function loadCursor(projectId: string): string | null {
  const p = cursorPath(projectId);
  if (!existsSync(p)) return null;
  try {
    const data = JSON.parse(readFileSync(p, "utf8")) as { updated_after?: string };
    return data.updated_after ?? null;
  } catch {
    return null;
  }
}

export function saveCursor(projectId: string, value: string): void {
  mkdirSync(CURSORS_DIR, { recursive: true });
  writeFileSync(cursorPath(projectId), JSON.stringify({ updated_after: value }), "utf8");
}

export function deleteCursor(projectId: string): void {
  const p = cursorPath(projectId);
  if (existsSync(p)) rmSync(p);
}
