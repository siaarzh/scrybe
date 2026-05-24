/**
 * Unit tests for src/daemon/migrate-models-cache.ts (Plan 66 Slice B).
 *
 * Tests inject temp dirs (oldDir / newDir) to avoid touching the real filesystem.
 */

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtemp, rm, mkdir, writeFile, readdir } from "fs/promises";
import { existsSync } from "fs";
import { join } from "path";
import { tmpdir } from "os";
import { migrateModelsCache } from "../src/daemon/migrate-models-cache.js";

async function makeTempDir(): Promise<string> {
  return mkdtemp(join(tmpdir(), "scrybe-test-migrate-"));
}

describe("migrateModelsCache (Plan 66 Slice B)", () => {
  let tmpRoot: string;
  let oldDir: string;
  let newDir: string;
  let dataDir: string;
  const logs: string[] = [];
  const log = (msg: string) => logs.push(msg);

  beforeEach(async () => {
    tmpRoot = await makeTempDir();
    oldDir = join(tmpRoot, "old-cache");
    dataDir = join(tmpRoot, "data");
    newDir = join(dataDir, "models", "Xenova");
    logs.length = 0;
    await mkdir(dataDir, { recursive: true });
  });

  afterEach(async () => {
    await rm(tmpRoot, { recursive: true, force: true });
  });

  it("moves the old Xenova dir to DATA_DIR/models/Xenova on first call", async () => {
    // Create a fake old cache with a sentinel file
    await mkdir(join(oldDir, "multilingual-e5-small"), { recursive: true });
    await writeFile(join(oldDir, "multilingual-e5-small", "model.onnx"), "fake-model-bytes");

    await migrateModelsCache(dataDir, log, oldDir, newDir);

    // New location should contain the sentinel file
    expect(existsSync(join(newDir, "multilingual-e5-small", "model.onnx"))).toBe(true);
    // Old location should be gone
    expect(existsSync(oldDir)).toBe(false);

    // Logged the move
    const moveLog = logs.find((l) => l.includes("moved") || l.includes("copied"));
    expect(moveLog).toBeDefined();
  });

  it("skips and logs when destination already exists (second call no-op)", async () => {
    // Create a fake old cache
    await mkdir(join(oldDir, "multilingual-e5-small"), { recursive: true });
    await writeFile(join(oldDir, "multilingual-e5-small", "model.onnx"), "fake-model-bytes");

    // Pre-create destination (simulates already-migrated state)
    await mkdir(newDir, { recursive: true });
    await writeFile(join(newDir, "existing.txt"), "already here");

    await migrateModelsCache(dataDir, log, oldDir, newDir);

    // Old dir should still be there (not moved)
    expect(existsSync(oldDir)).toBe(true);
    // Destination still has its original content
    expect(existsSync(join(newDir, "existing.txt"))).toBe(true);

    // Logged the skip
    const skipLog = logs.find((l) => l.includes("skipping") || l.includes("already"));
    expect(skipLog).toBeDefined();
  });

  it("is a silent no-op when old cache dir does not exist", async () => {
    // oldDir was never created
    await migrateModelsCache(dataDir, log, oldDir, newDir);

    // No new dir created
    expect(existsSync(newDir)).toBe(false);
    // No logs emitted
    expect(logs).toHaveLength(0);
  });
});
