import { readFileSync, writeFileSync, existsSync, renameSync, unlinkSync } from "fs";
import { join } from "path";
import { randomBytes } from "crypto";
import { config } from "./config.js";

const STATE_PATH = join(config.dataDir, "embed-batch-state.json");
const SCHEMA_VERSION = 1;

export interface EmbedBatchEntry {
  lastSuccessful: number;
  maxFailed: number;
  updatedAt: string;
}

interface StateFile {
  schemaVersion: number;
  entries: Record<string, EmbedBatchEntry>;
}

/** Compute the probe batch size for a new run from persisted state. */
export function computeProbeSize(entry: EmbedBatchEntry | null, ceiling: number): number {
  if (!entry) return ceiling;
  if (entry.maxFailed - entry.lastSuccessful <= 1) return entry.lastSuccessful; // converged
  return Math.floor((entry.lastSuccessful + entry.maxFailed) / 2);
}

/** Read a single entry by composite key, or null if absent. */
export function readEntry(key: string): EmbedBatchEntry | null {
  if (!existsSync(STATE_PATH)) return null;
  try {
    const state = JSON.parse(readFileSync(STATE_PATH, "utf8")) as StateFile;
    return state.entries?.[key] ?? null;
  } catch {
    return null;
  }
}

/** Persist a single entry update (atomic write). */
export function writeEntry(key: string, entry: { lastSuccessful: number; maxFailed: number }): void {
  let state: StateFile = { schemaVersion: SCHEMA_VERSION, entries: {} };
  if (existsSync(STATE_PATH)) {
    try {
      state = JSON.parse(readFileSync(STATE_PATH, "utf8")) as StateFile;
      if (typeof state.entries !== "object" || state.entries === null) state.entries = {};
    } catch {
      state = { schemaVersion: SCHEMA_VERSION, entries: {} };
    }
  }
  state.entries[key] = { ...entry, updatedAt: new Date().toISOString() };
  const tmp = `${STATE_PATH}.tmp-${randomBytes(4).toString("hex")}`;
  writeFileSync(tmp, JSON.stringify(state, null, 2) + "\n", "utf8");
  try {
    renameSync(tmp, STATE_PATH);
  } catch {
    try { unlinkSync(STATE_PATH); } catch { /* ignore */ }
    renameSync(tmp, STATE_PATH);
  }
}

/**
 * Delete every entry belonging to a source, regardless of provider/model.
 *
 * Keys are `${projectId}:${sourceId}:${base_url}:${model}` (see indexer.ts).
 * At source-removal time we don't know which provider/model the source last
 * used (it may have changed), so we delete by the `${projectId}:${sourceId}:`
 * prefix. No-op when the state file is absent or holds no matching entries.
 */
export function deleteEntriesForSource(projectId: string, sourceId: string): void {
  if (!existsSync(STATE_PATH)) return;
  let state: StateFile;
  try {
    state = JSON.parse(readFileSync(STATE_PATH, "utf8")) as StateFile;
  } catch {
    return; // unreadable — nothing safe to delete
  }
  if (typeof state.entries !== "object" || state.entries === null) return;
  const prefix = `${projectId}:${sourceId}:`;
  let removed = false;
  for (const key of Object.keys(state.entries)) {
    if (key.startsWith(prefix)) {
      delete state.entries[key];
      removed = true;
    }
  }
  if (!removed) return;
  const tmp = `${STATE_PATH}.tmp-${randomBytes(4).toString("hex")}`;
  writeFileSync(tmp, JSON.stringify(state, null, 2) + "\n", "utf8");
  try {
    renameSync(tmp, STATE_PATH);
  } catch {
    try { unlinkSync(STATE_PATH); } catch { /* ignore */ }
    renameSync(tmp, STATE_PATH);
  }
}
