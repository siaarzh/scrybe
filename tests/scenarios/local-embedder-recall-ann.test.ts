/**
 * Scenario 21 — hnswSq ANN-index recall validation (Plan 95 Phase 1, HARD GATE).
 *
 * Purpose: the 2026-07-03 experiment (`.plans/docs/benchmarks/2026-07-03-daemon-memory-and-ann-index.md`)
 * measured LanceDB's native `hnswSq` (HNSW + int8 scalar quantization) index at 99.1% recall@10
 * (100% with `refineFactor: 10`) vs exact brute-force on cmx-core (27,390 rows) — but that run used
 * STORED VECTORS AS QUERIES (exact top-k = gold), not real query strings, and reranking was not
 * exercised. This scenario re-validates the same claim on REAL query strings, through the SAME
 * golden-query fixture as Scenario 20 (`local-embedder-recall.test.ts`), with the local reranker ON
 * (matches how scrybe actually serves code search when `SCRYBE_RERANK=true`).
 *
 * Method:
 *   1. Index the same 30-file / ~218-chunk fixture via the CLI (local e5 embedder, vector-only —
 *      SCRYBE_HYBRID=false — to isolate the ANN-index effect from BM25/FTS compensation).
 *   2. Resolve the underlying LanceDB table_name from the isolated project registry.
 *   3. Import `embedQuery` / `rerank` / `@lancedb/lancedb` directly (in-process, not via the CLI —
 *      the CLI's `search code` path does not yet support `refineFactor` or force-exact selection;
 *      that's Plan 95 Phase 2, not implemented as of this gate). This test does NOT modify
 *      `src/vector-store.ts` or any production search path — it queries the same table three ways:
 *        - Arm 1 "exact"   — `.bypassVectorIndex()` (brute-force cosine, no ANN index yet)
 *        - Arm 2 "hnswSq"  — after `table.createIndex("vector", { config: Index.hnswSq({distanceType:"cosine"}) })`
 *        - Arm 3 "hnswSq+refine10" — same index, `.refineFactor(10)`
 *   4. Each arm fetches the SAME candidate-pool size scrybe's own orchestrator uses when rerank is on
 *      (`fetchCount = min(topK * rerankFetchMultiplier, MAX_RERANK_CANDIDATES)` — see `src/search.ts`;
 *      with topK=10 and the default multiplier 5, fetchCount=50), then reranks with the SAME
 *      `rerank()` (`src/reranker.ts`, local cross-encoder) used by production.
 *   5. Query embeddings are computed ONCE per golden query and reused across all 3 arms, so any
 *      metric delta reflects the retrieval/index method only — not embedding-run variance.
 *
 * Gate: hnswSq+refine10 (the config the grilled decisions settle on — refineFactor default 10) must
 * stay within TOLERANCE (proposed: 0.05 absolute) of exact on aggregate MRR@10 and recall@1, with
 * rerank ON. If this fails, Plan 95 Phases 2+ (the always-on hnswSq flip) must NOT proceed.
 *
 * Corpus-size caveat (same ceiling-clipping note as Scenario 20): this fixture is 218 chunks / 30
 * files — small next to the 27,390-row cmx-core run the original ANN experiment used. Metrics can
 * clip at 1.0 here, which weakens this test's ability to detect a *real* recall regression at scale.
 * Treat this as the "does the pattern hold on real strings + rerank at all" gate, not a substitute
 * for periodically re-measuring on a larger corpus.
 *
 * How to see full per-query numbers:
 *   SCRYBE_RECALL_VERBOSE=1 vitest run tests/scenarios/local-embedder-recall-ann.test.ts 2>&1 | grep "ann-recall-test"
 */

import { describe, it, expect, afterEach } from "vitest";
import * as lancedb from "@lancedb/lancedb";
import { makeScenarioEnv, runScrybe, type ScenarioEnv } from "./helpers/spawn.js";

import { join, dirname } from "path";
import { fileURLToPath } from "url";
import { readFileSync } from "fs";

const __dirname = dirname(fileURLToPath(import.meta.url));
// Same fixture as Scenario 20 — 30 files, ~218 chunks.
const FIXTURE_PATH = join(__dirname, "fixtures/local-embedder-recall");

// ─── Golden queries (same set as Scenario 20; thresholds dropped — this scenario ──
// gates on exact-vs-ANN delta, not absolute per-query floors) ──────────────────────
interface GoldenQuery {
  id: string;
  query: string;
  expectedPaths: string[];
}

const GOLDEN_QUERIES: GoldenQuery[] = [
  { id: "q01", query: "generate and sign a JSON Web Token with HMAC", expectedPaths: ["src/auth/jwt.ts"] },
  { id: "q02", query: "hash a password and compare with constant-time equality", expectedPaths: ["src/auth/password.ts"] },
  { id: "q03", query: "sliding session timeout with idle expiry", expectedPaths: ["src/auth/session.ts"] },
  { id: "q04", query: "fluent SQL query construction with WHERE clauses and pagination", expectedPaths: ["src/database/query-builder.ts"] },
  { id: "q05", query: "run pending database schema migrations and skip already-applied ones", expectedPaths: ["src/database/migrations.ts"] },
  { id: "q06", query: "HTTP request rate limiting per IP address", expectedPaths: ["src/api/middleware.ts", "src/api/rate-limiter.ts"] },
  { id: "q07", query: "retry a failing async operation with exponential backoff and jitter", expectedPaths: ["src/utils/retry.ts"] },
  { id: "q08", query: "move permanently failed jobs to dead letter queue and redrive them", expectedPaths: ["src/queue/dead-letter.ts"] },
  { id: "q09", query: "compute the next scheduled run time from a cron expression", expectedPaths: ["src/queue/scheduler.ts"] },
  { id: "q10", query: "cache-aside pattern with TTL eviction and namespace keying", expectedPaths: ["src/cache/redis.ts"] },
  { id: "q11", query: "verify outbound webhook HMAC signature to prevent tampering", expectedPaths: ["src/notifications/webhook.ts"] },
  { id: "q12", query: "symmetric encryption and decryption with AES-GCM authentication tag", expectedPaths: ["src/utils/crypto.ts"] },
  { id: "q13", query: "evaluate a feature flag with percentage-based user rollout", expectedPaths: ["src/utils/feature-flags.ts"] },
  { id: "q14", query: "open circuit breaker to stop cascading failures on repeated errors", expectedPaths: ["src/utils/circuit-breaker.ts"] },
  { id: "q15", query: "structured JSON logger with log levels and child logger context binding", expectedPaths: ["src/utils/logger.ts"] },
];

// ─── Metric helpers (operate on item_path arrays directly — no CLI text parsing ──
// needed since this test reads LanceDB rows in-process) ────────────────────────────

function recallAtK(expected: string[], actual: string[], k: number): number {
  if (expected.length === 0) return 1.0;
  const top = actual.slice(0, k);
  const found = expected.filter((exp) => top.some((act) => act.includes(exp)));
  return found.length / expected.length;
}

function recallAt1(expected: string[], actual: string[]): number {
  return recallAtK(expected, actual, 1);
}

function mrrAt10(expected: string[], actual: string[]): number {
  if (expected.length === 0) return 1.0;
  const top10 = actual.slice(0, 10);
  for (let i = 0; i < top10.length; i++) {
    if (expected.some((exp) => top10[i]!.includes(exp))) return 1 / (i + 1);
  }
  return 0.0;
}

// ─── Test ──────────────────────────────────────────────────────────────────────

let env: ScenarioEnv | null = null;

afterEach(() => {
  env?.cleanup();
  env = null;
});

/** Indexing env — mirrors Scenario 20's LOCAL_EMBEDDER_ENV. Rerank OFF here: reranking
 * happens in-process below (via the same production rerank() used at query time), not
 * during the indexing pass. Vector-only (SCRYBE_HYBRID=false) isolates the ANN-index
 * comparison from FTS/BM25 compensation. */
const INDEX_ENV: Record<string, string> = {
  SCRYBE_CODE_EMBEDDING_BASE_URL: "",
  SCRYBE_CODE_EMBEDDING_API_KEY: "",
  SCRYBE_CODE_EMBEDDING_MODEL: "",
  SCRYBE_CODE_EMBEDDING_DIMENSIONS: "",
  SCRYBE_LOCAL_EMBEDDER: "Xenova/multilingual-e5-small",
  SCRYBE_RERANK: "false",
  SCRYBE_HYBRID: "false",
};

const TOP_K = 10;
// Mirrors src/search.ts's fetchCount = min(topK * rerankFetchMultiplier(default 5), MAX_RERANK_CANDIDATES(500)).
const FETCH_COUNT = 50;
// Hard-gate tolerance proposed for this Phase-1 gate: hnswSq+refine10 must stay within this many
// absolute points of exact on aggregate MRR@10 / recall@1 (rerank ON). See plan.md Phase 1 acceptance.
const TOLERANCE = 0.05;

interface Candidate {
  chunk_id: string;
  item_path: string;
  content: string;
  score: number;
}

// Recall benchmark: downloads the e5 + local-reranker models and indexes 30 files. Too
// heavy/slow to gate CI (cold model download blows per-command timeouts). Runs locally
// by default; skipped on CI. Run manually to re-verify the hnswSq recall gate.
describe.skipIf(!!process.env.CI)(
  "Scenario 21 — hnswSq ANN-index recall gate (Plan 95 Phase 1)",
  () => {
    it(
      "compares exact vs hnswSq(+refine10) recall on real query strings, rerank ON",
      async () => {
        env = makeScenarioEnv();
        const projectId = "recall-ann";
        const sourceId = "primary";
        const verbose = process.env.SCRYBE_RECALL_VERBOSE === "1";

        // ── Build the corpus (CLI, isolated data dir) ─────────────────────────
        const addProj = runScrybe(
          ["project", "add", "--id", projectId, "--desc", "Plan-95 Phase 1 ANN recall gate"],
          env,
          INDEX_ENV,
          120_000
        );
        expect(addProj.exit, `project add failed:\n${addProj.stderr}`).toBe(0);

        const addSrc = runScrybe(
          ["source", "add", "-P", projectId, "-S", sourceId, "--type", "code", "--root", FIXTURE_PATH, "--languages", "ts"],
          env,
          INDEX_ENV,
          120_000
        );
        expect(addSrc.exit, `source add failed:\n${addSrc.stderr}`).toBe(0);

        const idx = runScrybe(["index", "-P", projectId, "-S", sourceId, "-f"], env, INDEX_ENV, 600_000);
        if (verbose) {
          process.stdout.write(`[ann-recall-test] index stdout:\n${idx.stdout}\n`);
          process.stdout.write(`[ann-recall-test] index stderr:\n${idx.stderr}\n`);
        }
        expect(idx.exit, `index failed:\n${idx.stderr}`).toBe(0);

        // ── Resolve the table_name the indexer assigned to this source ───────
        const projects = JSON.parse(readFileSync(join(env.dataDir, "projects.json"), "utf8")) as Array<{
          id: string;
          sources: Array<{ source_id: string; table_name?: string }>;
        }>;
        const project = projects.find((p) => p.id === projectId);
        const source = project?.sources.find((s) => s.source_id === sourceId);
        const tableName = source?.table_name;
        expect(tableName, "source table_name not assigned after indexing").toBeTruthy();

        // ── Wire THIS process's env so direct src imports (embedQuery / rerank /
        // config) resolve against the same isolated data dir and the same local
        // reranker production uses with SCRYBE_RERANK=true. Must happen before the
        // first import of these modules — config.ts computes its singleton at
        // module-load time from process.env, not lazily.
        process.env.SCRYBE_DATA_DIR = env.dataDir;
        process.env.SCRYBE_RERANK = "true";
        process.env.SCRYBE_RERANK_PROVIDER = "local";
        process.env.SCRYBE_HYBRID = "false";

        const { embedQuery } = await import("../../src/embedder.js");
        const { rerank } = await import("../../src/reranker.js");

        const embConfig = {
          base_url: "",
          model: "Xenova/multilingual-e5-small",
          dimensions: 384,
          api_key_env: "",
          provider_type: "local" as const,
          prompt_template: { query: "query: ", passage: "passage: " },
        };

        const db = await lancedb.connect(join(env.dataDir, "lancedb"));
        const table = await db.openTable(tableName!);

        function rowsToCandidates(rows: Record<string, unknown>[]): Candidate[] {
          return rows.map((row) => ({
            chunk_id: String(row.chunk_id),
            item_path: String(row.item_path),
            content: String(row.content),
            score: 1 - Number(row._distance ?? 0),
          }));
        }

        async function annQuery(
          vec: number[],
          opts: { useIndex: boolean; refineFactor?: number }
        ): Promise<Candidate[]> {
          let q = (table.search(Float32Array.from(vec)) as lancedb.VectorQuery).distanceType("cosine");
          if (!opts.useIndex) q = q.bypassVectorIndex();
          if (opts.refineFactor) q = q.refineFactor(opts.refineFactor);
          const rows = await q.limit(FETCH_COUNT).toArray();
          return rowsToCandidates(rows);
        }

        // ── Pre-embed every golden query once; reuse the SAME vector across all
        // 3 arms so metric deltas reflect retrieval method only. ────────────────
        const queryVecs = new Map<string, number[]>();
        for (const q of GOLDEN_QUERIES) {
          queryVecs.set(q.id, await embedQuery(q.query, embConfig));
        }

        async function runArm(opts: { useIndex: boolean; refineFactor?: number }) {
          const mrr: number[] = [];
          const r1: number[] = [];
          const r10: number[] = [];
          for (const q of GOLDEN_QUERIES) {
            const candidates = await annQuery(queryVecs.get(q.id)!, opts);
            const top = await rerank(q.query, candidates, TOP_K);
            const paths = top.map((c) => c.item_path);
            mrr.push(mrrAt10(q.expectedPaths, paths));
            r1.push(recallAt1(q.expectedPaths, paths));
            r10.push(recallAtK(q.expectedPaths, paths, 10));
          }
          return { mrr, r1, r10 };
        }

        // ── Arm 1: exact / brute-force — no ANN index exists on the table yet,
        // and bypassVectorIndex() forces it regardless. ─────────────────────────
        const exact = await runArm({ useIndex: false });

        // ── Build the hnswSq index. MUST be distanceType: "cosine" — an L2-metric
        // index is silently ignored by scrybe's cosine queries (LanceDB WARNs and
        // falls back to brute-force). ────────────────────────────────────────────
        await table.createIndex("vector", {
          config: lancedb.Index.hnswSq({ distanceType: "cosine" }),
          replace: true,
        });

        // ── Arm 2: hnswSq, no refine ──────────────────────────────────────────
        const ann = await runArm({ useIndex: true });

        // ── Arm 3: hnswSq + refineFactor 10 (the shipping config the grilled ──
        // decisions settle on) ───────────────────────────────────────────────────
        const refine = await runArm({ useIndex: true, refineFactor: 10 });

        const avg = (arr: number[]): number => arr.reduce((s, v) => s + v, 0) / arr.length;

        const agg = {
          exact: { mrr: avg(exact.mrr), r1: avg(exact.r1), r10: avg(exact.r10) },
          ann: { mrr: avg(ann.mrr), r1: avg(ann.r1), r10: avg(ann.r10) },
          refine: { mrr: avg(refine.mrr), r1: avg(refine.r1), r10: avg(refine.r10) },
        };

        // Always print the headline numbers — this test exists to produce them.
        process.stdout.write(
          `[ann-recall-test] rerank=ON fetchCount=${FETCH_COUNT} topK=${TOP_K} corpus=${GOLDEN_QUERIES.length}-queries/218-chunks\n` +
          `[ann-recall-test] exact           : MRR@10=${agg.exact.mrr.toFixed(3)}  recall@1=${agg.exact.r1.toFixed(3)}  recall@10=${agg.exact.r10.toFixed(3)}\n` +
          `[ann-recall-test] hnswSq          : MRR@10=${agg.ann.mrr.toFixed(3)}  recall@1=${agg.ann.r1.toFixed(3)}  recall@10=${agg.ann.r10.toFixed(3)}\n` +
          `[ann-recall-test] hnswSq+refine10 : MRR@10=${agg.refine.mrr.toFixed(3)}  recall@1=${agg.refine.r1.toFixed(3)}  recall@10=${agg.refine.r10.toFixed(3)}\n` +
          `[ann-recall-test] delta (exact - hnswSq+refine10): MRR@10=${(agg.exact.mrr - agg.refine.mrr).toFixed(3)}  recall@1=${(agg.exact.r1 - agg.refine.r1).toFixed(3)}  tolerance=${TOLERANCE}\n`
        );

        if (verbose) {
          GOLDEN_QUERIES.forEach((q, i) => {
            process.stdout.write(
              `[ann-recall-test] ${q.id}: ` +
              `exact(mrr=${exact.mrr[i]!.toFixed(2)},r1=${exact.r1[i]!.toFixed(2)},r10=${exact.r10[i]!.toFixed(2)}) ` +
              `hnswSq(mrr=${ann.mrr[i]!.toFixed(2)},r1=${ann.r1[i]!.toFixed(2)},r10=${ann.r10[i]!.toFixed(2)}) ` +
              `refine10(mrr=${refine.mrr[i]!.toFixed(2)},r1=${refine.r1[i]!.toFixed(2)},r10=${refine.r10[i]!.toFixed(2)})\n`
            );
          });
        }

        // ── HARD GATE: hnswSq+refine10 must stay within TOLERANCE absolute of
        // exact on both primary metrics, with rerank ON. If this fails, Plan 95
        // Phases 2+ (the always-on hnswSq flip) must NOT proceed. ────────────────
        expect(
          agg.exact.mrr - agg.refine.mrr,
          `hnswSq+refine10 MRR@10 (${agg.refine.mrr.toFixed(3)}) dropped more than ${TOLERANCE} below exact (${agg.exact.mrr.toFixed(3)})`
        ).toBeLessThanOrEqual(TOLERANCE);

        expect(
          agg.exact.r1 - agg.refine.r1,
          `hnswSq+refine10 recall@1 (${agg.refine.r1.toFixed(3)}) dropped more than ${TOLERANCE} below exact (${agg.exact.r1.toFixed(3)})`
        ).toBeLessThanOrEqual(TOLERANCE);
      },
      // 20-minute budget: e5 + local-reranker model downloads + 30-file index + 45 in-process searches.
      1_200_000
    );
  }
);
