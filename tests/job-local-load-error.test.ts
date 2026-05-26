/**
 * End-to-end: a local model-load failure during a reindex job surfaces the
 * friendly, classified error via the job's status (not a raw stack trace).
 *
 * Exercises the full wiring left un-tested by the unit tests:
 *   getPipeline tags the throw (error_type: "local_model_load")
 *     → propagates through indexSource → runTasks catch
 *     → classifyErrorMessage routes the tag through classifyLocalLoadError
 *     → friendly message lands in the job task's `error`, surfaced by getJobStatus.
 *
 * indexSource is mocked to throw a tagged error so we don't need a real model
 * download / network; the classification + job-surfacing path is real.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";

// Mutable error the mocked indexSource throws, set per test.
let _throw: Error | null = null;

vi.mock("../src/indexer.js", () => ({
  indexSource: vi.fn(async () => {
    if (_throw) throw _throw;
    return { files_scanned: 0, chunks_prepared: 0 };
  }),
  indexProject: vi.fn(async () => ({ files_scanned: 0, chunks_prepared: 0 })),
}));

function taggedLocalLoadError(message: string): Error {
  const err = new Error(message);
  (err as unknown as { error_type: string }).error_type = "local_model_load";
  return err;
}

async function waitForFailed(jobId: string) {
  const { getJobStatus } = await import("../src/jobs.js");
  for (let i = 0; i < 200; i++) {
    const s = getJobStatus(jobId);
    if (s && (s.status === "failed" || s.status === "done")) return s;
    await new Promise((r) => setTimeout(r, 10));
  }
  throw new Error("job did not reach a terminal state in time");
}

describe("local model-load failure surfaces a classified error via the job", () => {
  beforeEach(() => {
    _throw = null;
  });

  it("network failure → 'run once with internet' guidance in the job error", async () => {
    _throw = taggedLocalLoadError("getaddrinfo ENOTFOUND huggingface.co");
    const { submitSourceJob } = await import("../src/jobs.js");

    const result = submitSourceJob("proj-net", "code", "full");
    expect(typeof result).toBe("string");
    const jobId = result as string;

    const s = await waitForFailed(jobId);
    expect(s.status).toBe("failed");
    const taskError = s.tasks[0]?.error ?? "";
    expect(taskError).toContain("Run once with internet access");
    // Friendly classification, not the raw transformers stack.
    expect(taskError).not.toMatch(/^Error:/);
  });

  it("non-network failure → 'local embedder failed to load' guidance", async () => {
    _throw = taggedLocalLoadError("Could not locate file: 'Xenova/bogus-model/config.json'");
    const { submitSourceJob } = await import("../src/jobs.js");

    const result = submitSourceJob("proj-bad", "code", "full");
    const jobId = result as string;

    const s = await waitForFailed(jobId);
    expect(s.status).toBe("failed");
    expect(s.tasks[0]?.error ?? "").toContain("Local embedder failed to load");
  });
});
