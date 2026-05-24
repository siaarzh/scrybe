import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: ["tests/scenarios/**/*.test.ts"],
    // Scenarios spawn child processes (daemons, model-loading CLIs) — each has its
    // own DATA_DIR so parallelism is *correct*, but unbounded fork count starves
    // CI runners (memory + per-command latency), which surfaces as runner death
    // (ubuntu) or per-command timeouts (windows). Cap forks to keep the suite
    // within ~2× a single worker's footprint. See behavior/architecture docs.
    fileParallelism: true,
    // Vitest 4: concurrency is capped via top-level maxWorkers/minWorkers
    // (poolOptions was removed). Default pool is forks.
    minWorkers: 1,
    maxWorkers: 2,
    // Scenarios need the embedder sidecar for index commands
    globalSetup: ["./tests/setup.ts"],
    // No per-test DATA_DIR isolation from isolate.ts — each scenario manages its own sandbox
    setupFiles: [],
    testTimeout: 60_000,
    hookTimeout: 30_000,
    teardownTimeout: 10_000,
    forceRerunTriggers: [],
  },
});
