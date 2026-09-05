#!/usr/bin/env node
/**
 * Scrybe Embedder Benchmark
 *
 * Runs each WASM/ONNX candidate model against a fixed labeled corpus + query set.
 * Reports: disk size, cold-start ms, warm RPS, output dims, and retrieval quality
 * (recall@3, recall@5, MRR) overall and on cross-lingual queries only.
 *
 * Usage:
 *   node --import tsx/esm tests/embedder-bench/run.ts
 *   node --import tsx/esm tests/embedder-bench/run.ts --model multilingual-e5-small
 *   node --import tsx/esm tests/embedder-bench/run.ts --skip-size
 *
 * ---------------------------------------------------------------------------
 * REWRITTEN 2026-09-05 (Plan 126, decisions D1 and D2). Two defects were found
 * in the previous version and both invalidated its output:
 *
 *   D1  Its cross-lingual metric measured a proxy, not relevance. It scored
 *       "the top-3 holds at least one English-primary chunk" against a corpus
 *       that is 20/25 English, so a UNIFORMLY RANDOM ranking scores 99.57%
 *       against a stated threshold of 45% — the metric has no meaningful floor
 *       and never checked whether the RELEVANT chunk was found.
 *
 *       It is fair to record that it worked anyway. On the real candidates it
 *       tracked the correct metric closely (all-MiniLM-L6-v2: 40% old, 37% new;
 *       multilingual-e5-small: 100% both) and it did reject the English-only
 *       models. The 2026-04 decision it drove was right. It was replaced because
 *       a proxy that happens to correlate on five models cannot be trusted on
 *       the sixth, not because it had produced a wrong answer.
 *
 *   D2  It called the raw @xenova/transformers pipeline, not scrybe. Production
 *       embeds through embedLocalQuery / embedLocalBatched, which prepend
 *       prompt_template and apply capText. The harness therefore measured a
 *       function scrybe does not use.
 *
 * Both are fixed below: the metrics are scored against `relevant_chunk_ids`,
 * and every embedding goes through the production functions. Random baselines
 * are printed next to the results so a future reader can see at a glance
 * whether a metric discriminates at all.
 * ---------------------------------------------------------------------------
 */
import { readFileSync, readdirSync, lstatSync, existsSync } from "fs";
import { join, dirname } from "path";
import { fileURLToPath } from "url";
import { homedir } from "os";
import {
  embedLocalQuery,
  embedLocalBatched,
  resetLocalEmbedderCache,
  type LocalEmbedderOptions,
} from "../../src/local-embedder.js";

const __dirname = dirname(fileURLToPath(import.meta.url));

// ─── Types ───────────────────────────────────────────────────────────────────

interface CorpusChunk {
  id: string;
  primary_lang: "en" | "ru" | "zh" | "de";
  tags: string[];
  content: string;
}

interface Query {
  id: string;
  query: string;
  lang: "en" | "ru" | "zh" | "de";
  cross_lingual: boolean;
  relevant_chunk_ids: string[];
}

export interface BenchResult {
  modelId: string;
  notes: string;
  error?: string;
  diskMb?: number;
  coldStartMs?: number;
  actualDims?: number;
  warmRps?: number;
  recall3?: number;
  recall5?: number;
  mrr?: number;
  xRecall3?: number;
  xMrr?: number;
  xN?: number;
}

// ─── Candidate list ───────────────────────────────────────────────────────────

const CANDIDATES = [
  {
    id: "Xenova/all-MiniLM-L6-v2",
    notes: "English baseline (current test sidecar); 384d",
  },
  {
    id: "Xenova/paraphrase-multilingual-MiniLM-L12-v2",
    notes: "50+ languages, SBERT multilingual; 384d",
  },
  {
    id: "Xenova/multilingual-e5-small",
    notes: "E5 multilingual retrieval; 384d",
  },
  {
    id: "Xenova/jina-embeddings-v2-small-code",
    notes: "Code-aware, English-centric; 512d",
  },
  {
    id: "Xenova/bge-small-en-v1.5",
    notes: "Strong English baseline, no multilingual; 384d",
  },
  // Intentionally excluded (too large for default):
  // { id: "Xenova/bge-m3", notes: "Best multilingual but ~570 MB" },
];

/**
 * Mirror production's own rule for who gets a prompt_template.
 * `add-e5-prompt-template-v0.37.0` in src/migrations.ts applies it when the
 * model id matches /e5/i and explicitly leaves BGE and all-MiniLM alone.
 * Inventing a different rule here would reintroduce D2 in a new form.
 */
function optsFor(modelId: string): LocalEmbedderOptions {
  const opts: LocalEmbedderOptions = { modelId, dimensions: 0 };
  if (/e5/i.test(modelId)) {
    opts.prompt_template = { query: "query: ", passage: "passage: " };
  }
  return opts;
}

// ─── Helpers ─────────────────────────────────────────────────────────────────

function cosineSim(a: number[], b: number[]): number {
  let dot = 0;
  let na = 0;
  let nb = 0;
  for (let i = 0; i < a.length; i++) {
    dot += a[i] * b[i];
    na += a[i] * a[i];
    nb += b[i] * b[i];
  }
  const denom = Math.sqrt(na) * Math.sqrt(nb);
  return denom === 0 ? 0 : dot / denom;
}

function dirSizeMb(dir: string): number {
  if (!existsSync(dir)) return 0;
  let bytes = 0;
  const walk = (d: string) => {
    try {
      for (const entry of readdirSync(d)) {
        const full = join(d, entry);
        try {
          const stat = lstatSync(full);
          if (stat.isDirectory()) walk(full);
          else bytes += stat.size;
        } catch { /* skip inaccessible */ }
      }
    } catch { /* skip inaccessible */ }
  };
  walk(dir);
  return Math.round((bytes / (1024 * 1024)) * 10) / 10;
}

function getHfCacheDir(modelId: string): string {
  const safeName = "models--" + modelId.replace("/", "--");
  const cacheRoot =
    process.env.HF_HOME ??
    process.env.TRANSFORMERS_CACHE ??
    join(homedir(), process.platform === "win32" ? ".cache\\huggingface\\hub" : ".cache/huggingface/hub");
  return join(cacheRoot, safeName);
}

/** n-choose-k, for the combinatorial random baselines. */
function comb(n: number, k: number): number {
  if (k > n || k < 0) return 0;
  let r = 1;
  for (let i = 0; i < k; i++) r = (r * (n - i)) / (i + 1);
  return r;
}

// ─── Decision logic (pure — exported so tests can exercise it without ────────
// ─── running any model) ───────────────────────────────────────────────────

export interface SaturationResult {
  saturated: boolean;
  solvedCount: number;
  solvedModelIds: string[];
}

/**
 * Decide whether the fixture is saturated: more than one candidate scoring
 * 100% recall@3 means the fixture cannot rank them against each other, and
 * silently picking a "winner" off that tie is how a fixture stops being a
 * test. See Plan 126 D3.
 */
export function checkSaturation(results: BenchResult[]): SaturationResult {
  const solved = results.filter((r) => !r.error && (r.recall3 ?? 0) >= 1);
  return {
    saturated: solved.length > 1,
    solvedCount: solved.length,
    solvedModelIds: solved.map((r) => r.modelId),
  };
}

export type RecommendationReason =
  | "single-candidate-run"
  | "no-valid-candidates"
  | "recommended";

export interface RecommendationResult {
  recommended: BenchResult | null;
  reason: RecommendationReason;
}

/**
 * Decide whether to name a recommended default model from this run.
 *
 * Guards:
 * - A single-candidate run (`--model X` filtered the candidate list down to
 *   exactly one) that also produced exactly one valid result must never
 *   name a recommendation, even though that candidate cleared every
 *   threshold — naming one is how a filtered debugging run quietly turns
 *   into a decision. `candidatesRun` is the length of the filtered
 *   candidate list, independent of whether that candidate ended up valid.
 * - With zero valid candidates (whether from a single-candidate run or a
 *   full run where everything failed/oversized), there is nothing to
 *   recommend — reported as "no-valid-candidates", not folded into the
 *   single-candidate guard above.
 * - Otherwise, weight cross-lingual MRR highest (the axis with real
 *   headroom and the one the default model exists to serve), overall MRR
 *   next, and treat disk size as a mild penalty.
 */
export function pickRecommendation(
  valid: BenchResult[],
  candidatesRun: number
): RecommendationResult {
  if (valid.length === 1 && candidatesRun === 1) {
    return { recommended: null, reason: "single-candidate-run" };
  }
  if (valid.length === 0) {
    return { recommended: null, reason: "no-valid-candidates" };
  }
  const scored = valid
    .map((r) => ({
      r,
      score: (r.xMrr ?? 0) * 0.5 + (r.mrr ?? 0) * 0.3 - ((r.diskMb ?? 0) / 1000) * 0.2,
    }))
    .sort((a, b) => b.score - a.score);
  return { recommended: scored[0].r, reason: "recommended" };
}

// ─── Benchmark one model ─────────────────────────────────────────────────────

async function benchmarkModel(
  modelId: string,
  notes: string,
  corpus: CorpusChunk[],
  queries: Query[],
  skipSize: boolean
): Promise<BenchResult> {
  const opts = optsFor(modelId);

  // Cold-start: model load + first inference, through the production path.
  const t0 = Date.now();
  const probe = await embedLocalBatched(["ping"], opts);
  const coldStartMs = Date.now() - t0;
  const actualDims = probe[0].length;

  let diskMb: number | undefined;
  if (!skipSize) diskMb = dirSizeMb(getHfCacheDir(modelId));

  // Warm RPS: batch of 50 × 3 iterations.
  const warmTexts = Array.from({ length: 50 }, (_, i) => corpus[i % corpus.length].content);
  const ITERS = 3;
  let totalMs = 0;
  for (let i = 0; i < ITERS; i++) {
    const t = Date.now();
    await embedLocalBatched(warmTexts, opts);
    totalMs += Date.now() - t;
  }
  const warmRps = Math.round((50 * ITERS) / (totalMs / 1000));

  // Embed the corpus as passages, exactly as indexing would.
  const corpusVecs = await embedLocalBatched(corpus.map((c) => c.content), opts);

  let r3 = 0, r5 = 0, rr = 0;
  let xr3 = 0, xrr = 0, xN = 0;

  for (const q of queries) {
    const qVec = await embedLocalQuery(q.query, opts);
    const ranked = corpus
      .map((c, i) => ({ id: c.id, score: cosineSim(qVec, corpusVecs[i]) }))
      .sort((a, b) => b.score - a.score);

    const relevant = new Set(q.relevant_chunk_ids);
    // recall@k — of the chunks labelled relevant, how many made the top k.
    const rec3 = ranked.slice(0, 3).filter((x) => relevant.has(x.id)).length / relevant.size;
    const rec5 = ranked.slice(0, 5).filter((x) => relevant.has(x.id)).length / relevant.size;
    // MRR has no cutoff, so it cannot be gamed by choosing a friendly k.
    const firstRank = ranked.findIndex((x) => relevant.has(x.id)) + 1;
    const recip = firstRank > 0 ? 1 / firstRank : 0;

    r3 += rec3;
    r5 += rec5;
    rr += recip;

    if (q.cross_lingual) {
      xr3 += rec3;
      xrr += recip;
      xN++;
    }
  }

  const n = queries.length;
  return {
    modelId,
    notes,
    diskMb,
    coldStartMs,
    actualDims,
    warmRps,
    recall3: r3 / n,
    recall5: r5 / n,
    mrr: rr / n,
    xRecall3: xN > 0 ? xr3 / xN : undefined,
    xMrr: xN > 0 ? xrr / xN : undefined,
    xN,
  };
}

// ─── Main ────────────────────────────────────────────────────────────────────

async function main() {
  const args = process.argv.slice(2);
  const filterIdx = args.indexOf("--model");
  const filterModel = filterIdx !== -1 ? args[filterIdx + 1] : null;
  const skipSize = args.includes("--skip-size");

  const corpus: CorpusChunk[] = JSON.parse(
    readFileSync(join(__dirname, "fixtures/corpus.json"), "utf8")
  );
  const queries: Query[] = JSON.parse(
    readFileSync(join(__dirname, "fixtures/queries.json"), "utf8")
  );

  const N = corpus.length;
  const crossLingualCount = queries.filter((q) => q.cross_lingual).length;

  console.log("Scrybe Embedder Benchmark");
  console.log("=".repeat(56));
  console.log(
    `Corpus: ${N} chunks | Queries: ${queries.length} (${crossLingualCount} cross-lingual)`
  );
  console.log("Embeddings go through the production embedLocalQuery / embedLocalBatched.");
  console.log("\nRandom baselines (combinatorial — a metric near these discriminates nothing):");
  console.log(`  recall@3 ${(3 / N * 100).toFixed(1)}%   recall@5 ${(5 / N * 100).toFixed(1)}%`);
  const enShare = corpus.filter((c) => c.primary_lang === "en").length;
  console.log(
    `  The metric this harness used before Plan 126 — "top-3 holds any English chunk" —\n` +
    `  scores ${((1 - comb(N - enShare, 3) / comb(N, 3)) * 100).toFixed(2)}% at random, so it had no floor. It still ranked the 2026-04\n` +
    `  candidates correctly; it is gone because a proxy with no floor cannot be trusted\n` +
    `  on a model it has not already been checked against.\n`
  );

  const candidates = filterModel
    ? CANDIDATES.filter(
        (c) => c.id === filterModel || c.id.endsWith("/" + filterModel)
      )
    : CANDIDATES;

  if (candidates.length === 0) {
    console.error(`No candidate matching '${filterModel}'.`);
    console.error("Available:", CANDIDATES.map((c) => c.id).join(", "));
    process.exit(1);
  }

  const results: BenchResult[] = [];

  for (const cand of candidates) {
    process.stdout.write(`\n[${results.length + 1}/${candidates.length}] ${cand.id}\n`);
    process.stdout.write("  Loading model ... ");
    try {
      const r = await benchmarkModel(cand.id, cand.notes, corpus, queries, skipSize);
      results.push(r);
      process.stdout.write("done\n");
      process.stdout.write(
        `  cold=${r.coldStartMs}ms  rps=${r.warmRps}  dims=${r.actualDims}  ` +
        `r@3=${((r.recall3 ?? 0) * 100).toFixed(0)}%  MRR=${(r.mrr ?? 0).toFixed(3)}  ` +
        `xLing r@3=${r.xRecall3 !== undefined ? (r.xRecall3 * 100).toFixed(0) + "%" : "N/A"}\n`
      );
    } catch (err) {
      const msg = String(err);
      results.push({ modelId: cand.id, notes: cand.notes, error: msg });
      process.stdout.write(`FAILED\n  Error: ${msg.slice(0, 120)}\n`);
    } finally {
      // Each candidate loads its own pipeline; don't let five models accumulate.
      resetLocalEmbedderCache();
    }
  }

  // Summary table
  const W = { model: 46, mb: 7, cold: 9, rps: 6, dims: 6, r3: 7, r5: 7, mrr: 7, xr3: 8, xmrr: 8 };
  const line = "─".repeat(Object.values(W).reduce((a, b) => a + b, 0));

  console.log("\n\nRESULTS");
  console.log(line);
  console.log(
    "Model".padEnd(W.model) + "MB".padStart(W.mb) + "Cold(ms)".padStart(W.cold) +
    "RPS".padStart(W.rps) + "Dims".padStart(W.dims) + "r@3".padStart(W.r3) +
    "r@5".padStart(W.r5) + "MRR".padStart(W.mrr) + "xL r@3".padStart(W.xr3) + "xL MRR".padStart(W.xmrr)
  );
  console.log(line);

  for (const r of results) {
    if (r.error) {
      console.log(`${r.modelId.padEnd(W.model)} ERROR: ${r.error.slice(0, 50)}`);
      continue;
    }
    console.log(
      r.modelId.padEnd(W.model) +
      (r.diskMb !== undefined ? String(r.diskMb) : "?").padStart(W.mb) +
      String(r.coldStartMs ?? "?").padStart(W.cold) +
      String(r.warmRps ?? "?").padStart(W.rps) +
      String(r.actualDims ?? "?").padStart(W.dims) +
      `${((r.recall3 ?? 0) * 100).toFixed(0)}%`.padStart(W.r3) +
      `${((r.recall5 ?? 0) * 100).toFixed(0)}%`.padStart(W.r5) +
      (r.mrr ?? 0).toFixed(3).padStart(W.mrr) +
      (r.xRecall3 !== undefined ? `${(r.xRecall3 * 100).toFixed(0)}%` : "N/A").padStart(W.xr3) +
      (r.xMrr !== undefined ? r.xMrr.toFixed(3) : "N/A").padStart(W.xmrr)
    );
  }

  console.log(line);
  console.log("Thresholds: disk<150MB | cold<8000ms | RPS>50 | r@3>60% | cross-lingual r@3>45%");
  console.log(
    "\nNOTE: the RPS threshold predates Plan 126 and was set against the RAW pipeline.\n" +
    "Production embedLocalBatched applies token-budget micro-batching, so it is slower by\n" +
    "construction and the shipped default measures well under 50/s here. The threshold has\n" +
    "NOT been rewritten to fit — inventing a passing number would repeat exactly the mistake\n" +
    "Plan 126 found. Recalibrate it against a real indexing run before trusting it."
  );

  // Saturation warning. A fixture every candidate solves cannot rank them, and
  // silently picking a "winner" off a tie is how a fixture stops being a test.
  const saturation = checkSaturation(results);
  if (saturation.saturated) {
    console.log(
      `\n!! ${saturation.solvedCount} models scored 100% recall@3. The fixture is SATURATED and cannot\n` +
      `   rank them. It needs harder negatives — topically adjacent distractors — not more\n` +
      `   queries at this difficulty. See Plan 126 D3.`
    );
  }

  const valid = results.filter(
    (r) => !r.error && (r.diskMb === undefined || r.diskMb < 300)
  );

  const { recommended, reason } = pickRecommendation(valid, candidates.length);
  if (reason === "single-candidate-run") {
    // Naming a "recommended default" off a single-candidate run is how a
    // filtered debugging run turns into a decision. Refuse.
    console.log(
      "\nNo recommendation: only one candidate ran (--model was given). Run the full set\n" +
      "before treating any result here as a default-model decision."
    );
  } else if (reason === "recommended" && recommended) {
    console.log(`\nRecommended default: ${recommended.modelId}`);
    console.log(`  ${recommended.notes}`);
    console.log(
      `  r@3=${((recommended.recall3 ?? 0) * 100).toFixed(0)}%  MRR=${(recommended.mrr ?? 0).toFixed(3)}  ` +
      `xLing r@3=${((recommended.xRecall3 ?? 0) * 100).toFixed(0)}%  xLing MRR=${(recommended.xMrr ?? 0).toFixed(3)}  ` +
      `dims=${recommended.actualDims}  diskMb=${recommended.diskMb ?? "?"}  cold=${recommended.coldStartMs}ms`
    );
  } else {
    console.log("\nNo model cleared all thresholds. Review results above.");
  }

  console.log("\nDone.");
}

// Only run the benchmark when this file is executed directly (`node --import
// tsx/esm tests/embedder-bench/run.ts`). Without this guard, importing the
// module just to reach `pickRecommendation` / `checkSaturation` (as
// guards.test.ts does) would unconditionally kick off `main()` — loading
// real ONNX models and calling `process.exit` from inside the test process.
const isDirectRun = (() => {
  try {
    return import.meta.url === `file://${process.argv[1]}`;
  } catch {
    return false;
  }
})();

if (isDirectRun) {
  main().catch((err) => {
    console.error(err);
    process.exit(1);
  });
}
