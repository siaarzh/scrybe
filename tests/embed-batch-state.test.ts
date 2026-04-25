import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { mkdtempSync, rmSync } from "fs";
import { join } from "path";
import { tmpdir } from "os";

let tmp = "";

beforeEach(() => {
  tmp = mkdtempSync(join(tmpdir(), "scrybe-batch-state-"));
  vi.resetModules();
  process.env.SCRYBE_DATA_DIR = tmp;
});

afterEach(() => {
  delete process.env.SCRYBE_DATA_DIR;
  rmSync(tmp, { recursive: true, force: true });
  vi.restoreAllMocks();
});

async function loadState() {
  return import("../src/embed-batch-state.js");
}

// ─── 1. Probe selection ────────────────────────────────────────────────────────

describe("computeProbeSize — probe selection", () => {
  it("no entry → ceiling", async () => {
    const { computeProbeSize } = await loadState();
    expect(computeProbeSize(null, 100)).toBe(100);
  });

  it("converged (gap ≤ 1) → lastSuccessful", async () => {
    const { computeProbeSize } = await loadState();
    expect(computeProbeSize({ lastSuccessful: 63, maxFailed: 64, updatedAt: "" }, 100)).toBe(63);
  });

  it("binary search in progress → midpoint", async () => {
    const { computeProbeSize } = await loadState();
    expect(computeProbeSize({ lastSuccessful: 50, maxFailed: 100, updatedAt: "" }, 200)).toBe(75);
  });
});

// ─── 2. State read / write atomicity ──────────────────────────────────────────

describe("readEntry / writeEntry", () => {
  it("round-trips correctly and includes updatedAt", async () => {
    const { readEntry, writeEntry } = await loadState();
    const key = "p:s:https://api.example.com:model-v1";
    writeEntry(key, { lastSuccessful: 64, maxFailed: 128 });
    const entry = readEntry(key)!;
    expect(entry.lastSuccessful).toBe(64);
    expect(entry.maxFailed).toBe(128);
    expect(entry.updatedAt).toMatch(/^\d{4}-\d{2}-\d{2}T/);
  });

  it("second write overwrites first", async () => {
    const { readEntry, writeEntry } = await loadState();
    const key = "p:s:provider:model";
    writeEntry(key, { lastSuccessful: 64, maxFailed: 128 });
    writeEntry(key, { lastSuccessful: 75, maxFailed: 128 });
    expect(readEntry(key)!.lastSuccessful).toBe(75);
  });

  it("returns null for missing key", async () => {
    const { readEntry } = await loadState();
    expect(readEntry("nonexistent:key")).toBeNull();
  });
});

// ─── 3. Halve → session state update ──────────────────────────────────────────

describe("embedBatched halving session", () => {
  it("updates session on 400 error: sets halved, maxFailed, effectiveBatchSize", async () => {
    vi.resetModules();

    // Intercept openai so we can control when to throw 400
    let callCount = 0;
    vi.doMock("openai", () => ({
      default: class {
        embeddings = {
          create: async ({ input }: { input: string[] }) => {
            callCount++;
            if (input.length > 2) {
              const err = Object.assign(new Error("batch too large"), { status: 400 });
              throw err;
            }
            return { data: input.map((_, i) => ({ index: i, embedding: [0.1, 0.2, 0.3] })) };
          },
        };
      },
    }));

    process.env.FAKE_EMBED_KEY = "test-key";
    const { embedBatched } = await import("../src/embedder.js");

    const embConfig = {
      base_url: "https://api.test.com/v1",
      model: "test-model",
      dimensions: 3,
      api_key_env: "FAKE_EMBED_KEY",
    };
    const session = { effectiveBatchSize: 4, maxFailed: null as number | null, halved: false };
    const result = await embedBatched(["a", "b", "c", "d"], embConfig, 4, 0, session);

    expect(result).toHaveLength(4);
    expect(session.halved).toBe(true);
    expect(session.maxFailed).toBe(4);
    expect(session.effectiveBatchSize).toBe(2);
    expect(callCount).toBeGreaterThan(1); // at least 1 fail + 2 split calls

    delete process.env.FAKE_EMBED_KEY;
  });
});

// ─── 4. Run-cleanup persistence ───────────────────────────────────────────────

describe("writeEntry run-cleanup", () => {
  it("persists lastSuccessful + maxFailed from session at end of run", async () => {
    const { readEntry, writeEntry } = await loadState();
    const key = "proj:src:https://api.x.com:model-v2";

    // Simulate what indexer does at run completion
    const session = { effectiveBatchSize: 50, maxFailed: 100 as number | null, halved: true };
    writeEntry(key, {
      lastSuccessful: session.effectiveBatchSize,
      maxFailed: session.halved ? session.maxFailed! : 0,
    });

    const entry = readEntry(key)!;
    expect(entry.lastSuccessful).toBe(50);
    expect(entry.maxFailed).toBe(100);
  });

  it("persists lastSuccessful with 0 maxFailed when no halving occurred", async () => {
    const { readEntry, writeEntry } = await loadState();
    const key = "proj:src:provider:model";
    writeEntry(key, { lastSuccessful: 100, maxFailed: 0 });
    const entry = readEntry(key)!;
    expect(entry.lastSuccessful).toBe(100);
    expect(entry.maxFailed).toBe(0);
  });
});

// ─── 5. Provider-switch isolation ─────────────────────────────────────────────

describe("provider-switch isolation", () => {
  it("different base_url+model key = fresh null entry", async () => {
    const { readEntry, writeEntry } = await loadState();
    const key1 = "proj:src:https://api.voyageai.com/v1:voyage-code-3";
    const key2 = "proj:src:https://api.openai.com/v1:text-embedding-3-large";
    writeEntry(key1, { lastSuccessful: 50, maxFailed: 100 });
    expect(readEntry(key2)).toBeNull();
  });

  it("multiple keys stored independently in same file", async () => {
    const { readEntry, writeEntry } = await loadState();
    writeEntry("p-a:s:provider:model", { lastSuccessful: 32, maxFailed: 64 });
    writeEntry("p-b:s:provider:model", { lastSuccessful: 16, maxFailed: 32 });
    expect(readEntry("p-a:s:provider:model")!.lastSuccessful).toBe(32);
    expect(readEntry("p-b:s:provider:model")!.lastSuccessful).toBe(16);
  });
});
