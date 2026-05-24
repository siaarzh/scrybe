/**
 * Scenario 20 — Local-embedder recall baseline (Plan 77 Slices 1–2).
 *
 * Purpose: establish MRR@10 + recall@1 baselines for the current (unpatched) local e5
 * path so that later phases can ratchet thresholds upward as fixes land. recall@3 is
 * retained as a comparison datapoint but is NOT used for pass/fail (it clips at 0.967
 * on this small 218-chunk corpus and cannot discriminate slice improvements).
 *
 * Model under test: Xenova/multilingual-e5-small (384d, 512-token context)
 *
 * BASELINE — Slice 2 retune (2026-05-23, commit 82b02b3, unpatched e5, vector-only):
 *
 * Metrics used for pass/fail: MRR@10 (reciprocal rank of first expected hit in top-10)
 *                              recall@1 (was the #1 result an expected file?)
 * recall@3 retained for reference but NOT gating.
 *
 *   Query                                        | MRR@10 | recall@1 | recall@3
 *   ---------------------------------------------|--------|----------|----------
 *   q01 - JWT token creation signing              | 1.00   | 1.00     | 1.00
 *   q02 - password hashing constant-time compare  | 1.00   | 1.00     | 1.00
 *   q03 - session expiry sliding window           | 1.00   | 1.00     | 1.00
 *   q04 - SQL query builder fluent interface      | 1.00   | 1.00     | 1.00
 *   q05 - database migration runner               | 1.00   | 1.00     | 1.00
 *   q06 - HTTP middleware chain rate limiting     | 1.00   | 1.00     | 0.50
 *   q07 - async job retry exponential backoff     | 1.00   | 1.00     | 1.00
 *   q08 - dead letter queue redrive               | 1.00   | 1.00     | 1.00
 *   q09 - cron scheduler next run time            | 1.00   | 1.00     | 1.00
 *   q10 - Redis cache TTL expiry eviction         | 1.00   | 1.00     | 1.00
 *   q11 - HMAC webhook signature verification     | 1.00   | 1.00     | 1.00
 *   q12 - AES-256-GCM encryption authentication   | 1.00   | 1.00     | 1.00
 *   q13 - feature flag percentage rollout         | 1.00   | 1.00     | 1.00
 *   q14 - circuit breaker open half-open state    | 1.00   | 1.00     | 1.00
 *   q15 - structured logger child bindings        | 1.00   | 1.00     | 1.00
 *
 *   Aggregate MRR@10:  1.000 → threshold: 0.950 (= 1.000 - 0.05)
 *   Aggregate recall@1: 1.000 → threshold: 0.950 (= 1.000 - 0.05)
 *   Aggregate recall@3: 0.967 (comparison only, not gating)
 *
 * NOTE on ceiling clipping: MRR@10 and recall@1 are BOTH 1.000 on this small corpus —
 *   the same ceiling effect that recall@3 had at 0.967. However, MRR@10 + recall@1 ARE
 *   more discriminating on larger corpora (>10k chunks) where rank degrades significantly.
 *   The Slice 1 observation that "q01 JWT query: webhook.ts ranks #1" was NOT reproduced
 *   on this run — jwt.ts ranked #1, recall@1=1.00, MRR@10=1.00. The HMAC overlap appears
 *   run-to-run sensitive (different query ordering within same score ties).
 *   Finding: MRR@10 and recall@1 clip at 1.000 here. Flagged for Slice 3 notes.
 *
 * NOTE on q06: middleware.ts ranks #1; rate-limiter.ts appears at rank 4+.
 *   MRR@10 = 1.00 because middleware.ts IS in expectedPaths. recall@1 = 1.00.
 *   recall@3 = 0.50 because rate-limiter.ts (also in expectedPaths) is rank 4+.
 *   MRR@10 and recall@1 correctly surface that the top-1 hit is a good result.
 *
 * How to re-calibrate:
 *   SCRYBE_RECALL_VERBOSE=1 vitest run tests/scenarios/local-embedder-recall.test.ts 2>&1 | grep "recall-test"
 *
 * SLICE 1 BASELINE (recall@3, for reference):
 *   Aggregate recall@3: 0.967 → threshold: 0.917
 */

import { describe, it, expect, afterEach } from "vitest";
import { makeScenarioEnv, runScrybe, type ScenarioEnv } from "./helpers/spawn.js";

// ─── Fixture path ──────────────────────────────────────────────────────────────

import { join } from "path";
import { fileURLToPath } from "url";
import { dirname } from "path";

const __dirname = dirname(fileURLToPath(import.meta.url));
const FIXTURE_PATH = join(__dirname, "fixtures/local-embedder-recall");

// ─── Golden queries ────────────────────────────────────────────────────────────

interface GoldenQuery {
  id: string;
  query: string;
  /** File paths that MUST appear in top-k results (partial match on item_path). */
  expectedPaths: string[];
  /**
   * Per-query MRR@10 threshold (set to observed - 5% after Slice 2 calibration run).
   * This is the primary pass/fail gate for this query.
   */
  mrrThreshold: number;
  /**
   * Per-query recall@1 threshold (set to observed - 5% after Slice 2 calibration run).
   * Secondary pass/fail gate.
   */
  recall1Threshold: number;
  /**
   * Per-query recall@3 threshold. Retained from Slice 1 as a comparison datapoint.
   * NOT used for pass/fail — kept so recall@3 regressions are still visible in verbose output.
   */
  recall3Threshold: number;
}

// Queries are intentionally conceptual rather than keyword-exact to stress the
// asymmetric-retrieval bug: the query geometry differs from passage geometry in
// unpatched e5, suppressing true positives.
//
// Threshold fields (set to observed - 5% after Slice 2 calibration run):
//   mrrThreshold    — primary pass/fail (MRR@10)
//   recall1Threshold — secondary pass/fail (recall@1)
//   recall3Threshold — comparison only, NOT gating (retained from Slice 1)
const GOLDEN_QUERIES: GoldenQuery[] = [
  {
    id: "q01",
    query: "generate and sign a JSON Web Token with HMAC",
    expectedPaths: ["src/auth/jwt.ts"],
    // Empirical: jwt.ts ranks #1 → MRR@10=1.00, recall@1=1.00.
    // Note: HMAC vocabulary overlap with webhook.ts is run-to-run sensitive;
    // jwt.ts was top-1 on this Linux host, 2026-05-23. Threshold uses observed - 5%.
    mrrThreshold: 0.95,     // 1.00 - 0.05
    recall1Threshold: 0.95, // 1.00 - 0.05
    recall3Threshold: 0.95,
  },
  {
    id: "q02",
    query: "hash a password and compare with constant-time equality",
    expectedPaths: ["src/auth/password.ts"],
    mrrThreshold: 0.95,     // 1.00 - 0.05
    recall1Threshold: 0.95, // 1.00 - 0.05
    recall3Threshold: 0.95,
  },
  {
    id: "q03",
    query: "sliding session timeout with idle expiry",
    expectedPaths: ["src/auth/session.ts"],
    mrrThreshold: 0.95,
    recall1Threshold: 0.95,
    recall3Threshold: 0.95,
  },
  {
    id: "q04",
    query: "fluent SQL query construction with WHERE clauses and pagination",
    expectedPaths: ["src/database/query-builder.ts"],
    mrrThreshold: 0.95,
    recall1Threshold: 0.95,
    recall3Threshold: 0.95,
  },
  {
    id: "q05",
    query: "run pending database schema migrations and skip already-applied ones",
    expectedPaths: ["src/database/migrations.ts"],
    mrrThreshold: 0.95,
    recall1Threshold: 0.95,
    recall3Threshold: 0.95,
  },
  {
    id: "q06",
    query: "HTTP request rate limiting per IP address",
    // middleware.ts ranks #1 (it IS in expectedPaths) → MRR@10=1.00, recall@1=1.00.
    // rate-limiter.ts (also in expectedPaths) is rank 4+, so recall@3=0.50.
    // MRR@10 and recall@1 correctly surface the top-1 is a good result.
    expectedPaths: ["src/api/middleware.ts", "src/api/rate-limiter.ts"],
    mrrThreshold: 0.95,     // 1.00 - 0.05
    recall1Threshold: 0.95, // 1.00 - 0.05
    recall3Threshold: 0.45, // 0.50 - 0.05 (retained from Slice 1)
  },
  {
    id: "q07",
    query: "retry a failing async operation with exponential backoff and jitter",
    expectedPaths: ["src/utils/retry.ts"],
    mrrThreshold: 0.95,
    recall1Threshold: 0.95,
    recall3Threshold: 0.95,
  },
  {
    id: "q08",
    query: "move permanently failed jobs to dead letter queue and redrive them",
    expectedPaths: ["src/queue/dead-letter.ts"],
    mrrThreshold: 0.95,
    recall1Threshold: 0.95,
    recall3Threshold: 0.95,
  },
  {
    id: "q09",
    query: "compute the next scheduled run time from a cron expression",
    expectedPaths: ["src/queue/scheduler.ts"],
    mrrThreshold: 0.95,
    recall1Threshold: 0.95,
    recall3Threshold: 0.95,
  },
  {
    id: "q10",
    query: "cache-aside pattern with TTL eviction and namespace keying",
    expectedPaths: ["src/cache/redis.ts"],
    mrrThreshold: 0.95,
    recall1Threshold: 0.95,
    recall3Threshold: 0.95,
  },
  {
    id: "q11",
    query: "verify outbound webhook HMAC signature to prevent tampering",
    expectedPaths: ["src/notifications/webhook.ts"],
    mrrThreshold: 0.95,
    recall1Threshold: 0.95,
    recall3Threshold: 0.95,
  },
  {
    id: "q12",
    query: "symmetric encryption and decryption with AES-GCM authentication tag",
    expectedPaths: ["src/utils/crypto.ts"],
    mrrThreshold: 0.95,
    recall1Threshold: 0.95,
    recall3Threshold: 0.95,
  },
  {
    id: "q13",
    query: "evaluate a feature flag with percentage-based user rollout",
    expectedPaths: ["src/utils/feature-flags.ts"],
    mrrThreshold: 0.95,
    recall1Threshold: 0.95,
    recall3Threshold: 0.95,
  },
  {
    id: "q14",
    query: "open circuit breaker to stop cascading failures on repeated errors",
    expectedPaths: ["src/utils/circuit-breaker.ts"],
    mrrThreshold: 0.95,
    recall1Threshold: 0.95,
    recall3Threshold: 0.95,
  },
  {
    id: "q15",
    query: "structured JSON logger with log levels and child logger context binding",
    expectedPaths: ["src/utils/logger.ts"],
    mrrThreshold: 0.95,
    recall1Threshold: 0.95,
    recall3Threshold: 0.95,
  },
];

// ─── Aggregate thresholds ──────────────────────────────────────────────────────
// Slice 2 baselines (unpatched e5, vector-only, 2026-05-23, empirically observed):
//   MRR@10:   observed 1.000, threshold = 1.000 - 0.05 = 0.950
//   recall@1: observed 1.000, threshold = 1.000 - 0.05 = 0.950
//   recall@3: observed 0.967, threshold = 0.917 (reference only, not gating)
//
// Note: MRR@10 + recall@1 ALSO clip at 1.000 on this small corpus (218 chunks).
// This is consistent with recall@3 clipping at 0.967 in Slice 1. These metrics
// are more discriminating on larger corpora (>10k chunks). The 0.95 threshold
// ensures regressions are caught; later slices will confirm behavior at larger scale.
// Slice 3 (prompt_template prefix fix) should maintain or improve MRR@10 + recall@1.
// Slice 4 (max_input_tokens) and Slice 5 (local reranker) ratchet further.
const AGGREGATE_MRR_THRESHOLD = 0.950;
const AGGREGATE_RECALL1_THRESHOLD = 0.950;
// Retained from Slice 1 for reference — NOT a pass/fail gate.
const AGGREGATE_RECALL3_REFERENCE = 0.917;

// ─── Recall helpers ────────────────────────────────────────────────────────────

/**
 * Extract the top-N file paths from `scrybe search code` CLI output.
 * Lines look like: `[0.812] src/auth/jwt.ts:1-30 (typescript)`
 */
function extractTopFilePaths(stdout: string, n: number): string[] {
  return stdout
    .split("\n")
    .filter((line) => line.trimStart().startsWith("["))
    .slice(0, n)
    .map((line) => {
      const m = line.match(/\]\s+(.+?):\d/);
      return m ? m[1]!.trim() : "";
    })
    .filter(Boolean);
}

/**
 * Compute recall@k: fraction of expected paths that appear in actual top-k results.
 * A path is "found" if any actual result CONTAINS the expected string (partial/prefix match).
 */
function recallAtK(expected: string[], actual: string[]): number {
  if (expected.length === 0) return 1.0;
  const found = expected.filter((exp) => actual.some((act) => act.includes(exp)));
  return found.length / expected.length;
}

/**
 * Compute recall@1: was the #1 result an expected path?
 * Returns 1.0 if the first result matches any expected path, 0.0 otherwise.
 * This is equivalent to recallAtK(expected, actual.slice(0, 1)) for single-path cases,
 * but also works for multi-path expectations (any match at rank 1 counts).
 */
function recallAt1(expected: string[], actual: string[]): number {
  if (expected.length === 0) return 1.0;
  if (actual.length === 0) return 0.0;
  const top1 = actual[0]!;
  return expected.some((exp) => top1.includes(exp)) ? 1.0 : 0.0;
}

/**
 * Compute MRR@10: reciprocal rank of the first result (within top-10) that matches
 * any expected path. If no expected path appears in top-10, returns 0.
 *
 * For multi-path expectations (e.g. q06 with middleware.ts + rate-limiter.ts), the
 * reciprocal rank is based on whichever expected path appears FIRST in the ranked list.
 * This means if middleware.ts is rank 1, MRR@10 = 1/1 = 1.00, even if rate-limiter.ts
 * is at rank 4+ — the first hit is the signal.
 *
 * Ranking is 1-indexed (rank 1 = top result).
 */
function mrrAt10(expected: string[], actual: string[]): number {
  if (expected.length === 0) return 1.0;
  const top10 = actual.slice(0, 10);
  for (let i = 0; i < top10.length; i++) {
    const path = top10[i]!;
    if (expected.some((exp) => path.includes(exp))) {
      return 1 / (i + 1); // rank is 1-indexed
    }
  }
  return 0.0;
}

// ─── Test ──────────────────────────────────────────────────────────────────────

let env: ScenarioEnv | null = null;

afterEach(() => {
  env?.cleanup();
  env = null;
});

/**
 * Env overrides that route through the local e5 embedder instead of the sidecar.
 * Unsets all sidecar-wiring keys so buildEmbeddingConfig() falls through to isLocal.
 */
const LOCAL_EMBEDDER_ENV: Record<string, string> = {
  // Clear sidecar wiring — empty string normalizes to undefined in envStr()
  SCRYBE_CODE_EMBEDDING_BASE_URL: "",
  SCRYBE_CODE_EMBEDDING_API_KEY: "",
  SCRYBE_CODE_EMBEDDING_MODEL: "",
  SCRYBE_CODE_EMBEDDING_DIMENSIONS: "",
  // Explicitly request the production default local model
  SCRYBE_LOCAL_EMBEDDER: "Xenova/multilingual-e5-small",
  // Disable rerank (not testing that here)
  SCRYBE_RERANK: "false",
  // Vector-only mode to isolate embedding quality from BM25 compensation.
  // FTS hybrid search masks the asymmetric-retrieval bug (exact token matches
  // compensate for poor vector geometry). Testing vector-only surfaces the gap
  // that the prompt_template and max_input_tokens fixes address.
  SCRYBE_HYBRID: "false",
};

describe("Scenario 20 — local-embedder MRR@10 + recall@1 baseline (Plan 77)", () => {
  it(
    "indexes the recall fixture and evaluates MRR@10 + recall@1 for all golden queries",
    async () => {
      env = makeScenarioEnv();
      const projectId = "recall-baseline";
      const sourceId = "primary";
      const verbose = process.env.SCRYBE_RECALL_VERBOSE === "1";

      // ── Register project ────────────────────────────────────────────────────
      const addProj = runScrybe(
        ["project", "add", "--id", projectId, "--desc", "Plan-77 recall baseline"],
        env,
        LOCAL_EMBEDDER_ENV,
        120_000
      );
      expect(addProj.exit, `project add failed:\n${addProj.stderr}`).toBe(0);

      // ── Register source ─────────────────────────────────────────────────────
      const addSrc = runScrybe(
        [
          "source", "add",
          "-P", projectId,
          "-S", sourceId,
          "--type", "code",
          "--root", FIXTURE_PATH,
          "--languages", "ts",
        ],
        env,
        LOCAL_EMBEDDER_ENV,
        120_000
      );
      expect(addSrc.exit, `source add failed:\n${addSrc.stderr}`).toBe(0);

      // ── Full index ──────────────────────────────────────────────────────────
      // This is the slow step: downloads + loads Xenova/multilingual-e5-small (~50MB)
      // then embeds 30 files. Expect 3-5 minutes on first cold run.
      const idx = runScrybe(
        ["index", "-P", projectId, "-S", sourceId, "-f"],
        env,
        LOCAL_EMBEDDER_ENV,
        600_000  // 10-minute limit — cold model download can be slow
      );
      if (verbose) {
        process.stdout.write(`[recall-test] index stdout:\n${idx.stdout}\n`);
        process.stdout.write(`[recall-test] index stderr:\n${idx.stderr}\n`);
      }
      expect(idx.exit, `index failed:\n${idx.stderr}`).toBe(0);

      // ── Evaluate golden queries ─────────────────────────────────────────────
      const perQueryMrr: number[] = [];
      const perQueryRecall1: number[] = [];
      const perQueryRecall3: number[] = [];

      for (const q of GOLDEN_QUERIES) {
        const r = runScrybe(
          ["search", "code", "-P", projectId, "--top-k", "10", q.query],
          env,
          LOCAL_EMBEDDER_ENV,
          120_000
        );
        expect(r.exit, `search failed for ${q.id}:\n${r.stderr}`).toBe(0);

        // Extract top-10 for MRR@10, top-3 for recall@3 (comparison), top-1 for recall@1
        const top10 = extractTopFilePaths(r.stdout, 10);
        const top3 = top10.slice(0, 3);

        const mrr = mrrAt10(q.expectedPaths, top10);
        const r1 = recallAt1(q.expectedPaths, top10);
        const r3 = recallAtK(q.expectedPaths, top3);

        perQueryMrr.push(mrr);
        perQueryRecall1.push(r1);
        perQueryRecall3.push(r3);

        if (verbose) {
          process.stdout.write(
            `[recall-test] ${q.id}: mrr@10=${mrr.toFixed(2)} recall@1=${r1.toFixed(2)} recall@3=${r3.toFixed(2)} ` +
            `top3=${JSON.stringify(top3)} expected=${JSON.stringify(q.expectedPaths)}\n`
          );
        }

        // ── Per-query MRR@10 assertion (primary gate) ───────────────────────
        expect(
          mrr,
          `${q.id} MRR@10 (${mrr.toFixed(2)}) below threshold (${q.mrrThreshold.toFixed(2)})\n` +
          `  query: "${q.query}"\n` +
          `  top-10: ${JSON.stringify(top10)}\n` +
          `  expected one of: ${JSON.stringify(q.expectedPaths)}`
        ).toBeGreaterThanOrEqual(q.mrrThreshold);

        // ── Per-query recall@1 assertion (secondary gate) ───────────────────
        expect(
          r1,
          `${q.id} recall@1 (${r1.toFixed(2)}) below threshold (${q.recall1Threshold.toFixed(2)})\n` +
          `  query: "${q.query}"\n` +
          `  top-1: ${JSON.stringify(top10[0])}\n` +
          `  expected one of: ${JSON.stringify(q.expectedPaths)}`
        ).toBeGreaterThanOrEqual(q.recall1Threshold);

        // ── Per-query recall@3 (comparison only — always passes) ────────────
        // Not gating; logged in verbose output for reference against Slice 1.
        if (verbose) {
          const aboveFloor = r3 >= q.recall3Threshold;
          process.stdout.write(
            `[recall-test] ${q.id} recall@3 reference: ${r3.toFixed(2)} ` +
            `(floor=${q.recall3Threshold.toFixed(2)}, ${aboveFloor ? "ok" : "below-floor"})\n`
          );
        }
      }

      // ── Aggregate assertions ────────────────────────────────────────────────
      const aggregateMrr = perQueryMrr.reduce((s, v) => s + v, 0) / perQueryMrr.length;
      const aggregateRecall1 = perQueryRecall1.reduce((s, v) => s + v, 0) / perQueryRecall1.length;
      const aggregateRecall3 = perQueryRecall3.reduce((s, v) => s + v, 0) / perQueryRecall3.length;

      if (verbose) {
        process.stdout.write(
          `[recall-test] aggregate MRR@10: ${aggregateMrr.toFixed(3)} ` +
          `(threshold: ${AGGREGATE_MRR_THRESHOLD.toFixed(3)})\n`
        );
        process.stdout.write(
          `[recall-test] aggregate recall@1: ${aggregateRecall1.toFixed(3)} ` +
          `(threshold: ${AGGREGATE_RECALL1_THRESHOLD.toFixed(3)})\n`
        );
        process.stdout.write(
          `[recall-test] aggregate recall@3 (reference): ${aggregateRecall3.toFixed(3)} ` +
          `(floor: ${AGGREGATE_RECALL3_REFERENCE.toFixed(3)})\n`
        );
        process.stdout.write(
          `[recall-test] per-query mrr@10: ${perQueryMrr.map((v, i) => `${GOLDEN_QUERIES[i]!.id}=${v.toFixed(2)}`).join(" ")}\n`
        );
        process.stdout.write(
          `[recall-test] per-query recall@1: ${perQueryRecall1.map((v, i) => `${GOLDEN_QUERIES[i]!.id}=${v.toFixed(2)}`).join(" ")}\n`
        );
        process.stdout.write(
          `[recall-test] per-query recall@3: ${perQueryRecall3.map((v, i) => `${GOLDEN_QUERIES[i]!.id}=${v.toFixed(2)}`).join(" ")}\n`
        );
      }

      // Primary gate: aggregate MRR@10
      expect(
        aggregateMrr,
        `Aggregate MRR@10 (${aggregateMrr.toFixed(3)}) below threshold (${AGGREGATE_MRR_THRESHOLD.toFixed(3)})\n` +
        `Per-query: ${perQueryMrr.map((v, i) => `${GOLDEN_QUERIES[i]!.id}=${v.toFixed(2)}`).join(", ")}`
      ).toBeGreaterThanOrEqual(AGGREGATE_MRR_THRESHOLD);

      // Secondary gate: aggregate recall@1
      expect(
        aggregateRecall1,
        `Aggregate recall@1 (${aggregateRecall1.toFixed(3)}) below threshold (${AGGREGATE_RECALL1_THRESHOLD.toFixed(3)})\n` +
        `Per-query: ${perQueryRecall1.map((v, i) => `${GOLDEN_QUERIES[i]!.id}=${v.toFixed(2)}`).join(", ")}`
      ).toBeGreaterThanOrEqual(AGGREGATE_RECALL1_THRESHOLD);
    },
    // Test timeout: allow 15 minutes total (model download + 30-file index + 15 searches)
    900_000
  );
});
