#!/usr/bin/env node
/**
 * Scrybe Embedder Benchmark — M-D5 Phase 1
 *
 * Runs each WASM/ONNX candidate model against a fixed labeled corpus + query set.
 * Reports: disk size, cold-start ms, warm RPS, output dims, P@5, cross-lingual hit rate.
 *
 * Usage:
 *   node --import tsx/esm tests/embedder-bench/run.ts
 *   node --import tsx/esm tests/embedder-bench/run.ts --model all-MiniLM-L6-v2
 *   node --import tsx/esm tests/embedder-bench/run.ts --skip-size
 */
import { pipeline, type FeatureExtractionPipeline } from "@xenova/transformers";
import { readFileSync, readdirSync, lstatSync, existsSync } from "fs";
import { join, dirname } from "path";
import { fileURLToPath } from "url";
import { homedir } from "os";

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

interface BenchResult {
  modelId: string;
  notes: string;
  error?: string;
  diskMb?: number;
  coldStartMs?: number;
  actualDims?: number;
  warmRps?: number;
  meanP5?: number;
  enP5?: number;
  crossLingualHitRate?: number;
  crossLingualN?: number;
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

function toVec(output: any, idx: number): number[] {
  return Array.from(output[idx].data as Float32Array);
}

// ─── Benchmark one model ─────────────────────────────────────────────────────

async function benchmarkModel(
  modelId: string,
  notes: string,
  corpus: CorpusChunk[],
  queries: Query[],
  skipSize: boolean
): Promise<BenchResult> {
  // Cold-start (includes model load + pipeline setup + first inference)
  const t0 = Date.now();
  const extractor: FeatureExtractionPipeline = await pipeline(
    "feature-extraction",
    modelId,
    { revision: "main" }
  );
  await extractor(["ping"], { pooling: "mean", normalize: true });
  const coldStartMs = Date.now() - t0;

  // Actual output dimensions
  const pingOut = await extractor(["dimension_probe"], { pooling: "mean", normalize: true });
  const actualDims = toVec(pingOut, 0).length;

  // Disk size from HF cache
  let diskMb: number | undefined;
  if (!skipSize) {
    diskMb = dirSizeMb(getHfCacheDir(modelId));
  }

  // Warm RPS: batch of 50 × 3 iterations
  const warmTexts = Array.from({ length: 50 }, (_, i) => corpus[i % corpus.length].content);
  const ITERS = 3;
  let totalMs = 0;
  for (let i = 0; i < ITERS; i++) {
    const t = Date.now();
    await extractor(warmTexts, { pooling: "mean", normalize: true });
    totalMs += Date.now() - t;
  }
  const warmRps = Math.round((50 * ITERS) / (totalMs / 1000));

  // Embed the entire corpus in one batch
  const corpusTexts = corpus.map((c) => c.content);
  const corpusOut = await extractor(corpusTexts, { pooling: "mean", normalize: true });
  const corpusVecs = corpus.map((_, i) => toVec(corpusOut, i));

  // Precision@5 for each query
  let totalP5 = 0;
  let enP5Total = 0;
  let enCount = 0;
  let clHits = 0;
  let clTotal = 0;

  for (const q of queries) {
    const qOut = await extractor([q.query], { pooling: "mean", normalize: true });
    const qVec = toVec(qOut, 0);

    const ranked = corpus
      .map((c, i) => ({ id: c.id, score: cosineSim(qVec, corpusVecs[i]) }))
      .sort((a, b) => b.score - a.score);

    const top5 = new Set(ranked.slice(0, 5).map((r) => r.id));
    const relevant = q.relevant_chunk_ids;
    const hits = relevant.filter((id) => top5.has(id)).length;
    const p5 = relevant.length > 0 ? hits / relevant.length : 0;
    totalP5 += p5;

    if (q.lang === "en") {
      enP5Total += p5;
      enCount++;
    }

    if (q.cross_lingual) {
      clTotal++;
      // Cross-lingual: top-3 must contain at least 1 English-primary chunk
      const top3 = ranked.slice(0, 3).map((r) => r.id);
      const crossHit = top3.some((id) => {
        const chunk = corpus.find((c) => c.id === id);
        return chunk?.primary_lang === "en";
      });
      if (crossHit) clHits++;
    }
  }

  return {
    modelId,
    notes,
    diskMb,
    coldStartMs,
    actualDims,
    warmRps,
    meanP5: totalP5 / queries.length,
    enP5: enCount > 0 ? enP5Total / enCount : 0,
    crossLingualHitRate: clTotal > 0 ? clHits / clTotal : undefined,
    crossLingualN: clTotal,
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

  const crossLingualCount = queries.filter((q) => q.cross_lingual).length;

  console.log("Scrybe Embedder Benchmark (M-D5 Phase 1)");
  console.log("=".repeat(50));
  console.log(
    `Corpus: ${corpus.length} chunks | Queries: ${queries.length} (${crossLingualCount} cross-lingual)\n`
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
      process.stdout.write(`done\n`);
      process.stdout.write(
        `  cold=${r.coldStartMs}ms  rps=${r.warmRps}  dims=${r.actualDims}  ` +
        `P@5=${((r.meanP5 ?? 0) * 100).toFixed(0)}%  enP@5=${((r.enP5 ?? 0) * 100).toFixed(0)}%  ` +
        `xLing=${r.crossLingualHitRate !== undefined ? ((r.crossLingualHitRate) * 100).toFixed(0) + "%" : "N/A"}\n`
      );
    } catch (err) {
      const msg = String(err);
      results.push({ modelId: cand.id, notes: cand.notes, error: msg });
      process.stdout.write(`FAILED\n  Error: ${msg.slice(0, 120)}\n`);
    }
  }

  // Summary table
  const W = {
    model: 50,
    mb: 6,
    cold: 10,
    rps: 6,
    dims: 6,
    p5: 6,
    enp5: 7,
    xl: 7,
  };
  const line = "─".repeat(Object.values(W).reduce((a, b) => a + b, 0) + 2);

  console.log("\n\nRESULTS");
  console.log(line);
  console.log(
    "Model".padEnd(W.model) +
    "MB".padStart(W.mb) +
    "Cold(ms)".padStart(W.cold) +
    "RPS".padStart(W.rps) +
    "Dims".padStart(W.dims) +
    "P@5".padStart(W.p5) +
    "enP@5".padStart(W.enp5) +
    "xLing".padStart(W.xl)
  );
  console.log(line);

  for (const r of results) {
    if (r.error) {
      console.log(`${r.modelId.padEnd(W.model)} ERROR: ${r.error.slice(0, 50)}`);
    } else {
      console.log(
        r.modelId.padEnd(W.model) +
        (r.diskMb !== undefined ? String(r.diskMb) : "?").padStart(W.mb) +
        String(r.coldStartMs ?? "?").padStart(W.cold) +
        String(r.warmRps ?? "?").padStart(W.rps) +
        String(r.actualDims ?? "?").padStart(W.dims) +
        `${((r.meanP5 ?? 0) * 100).toFixed(0)}%`.padStart(W.p5) +
        `${((r.enP5 ?? 0) * 100).toFixed(0)}%`.padStart(W.enp5) +
        (r.crossLingualHitRate !== undefined
          ? `${(r.crossLingualHitRate * 100).toFixed(0)}%`
          : "N/A"
        ).padStart(W.xl)
      );
    }
  }

  console.log(line);
  console.log("\nThresholds: disk<150MB | cold<8000ms | RPS>50 | P@5(en)>60% | xLing>45%");

  // Recommendation heuristic:
  // Score = xLing*0.5 + meanP@5*0.3 - diskMb/1000*0.2 (penalise size)
  // Filter: must pass xLing threshold (>0) and not have errored
  const valid = results.filter(
    (r) =>
      !r.error &&
      (r.crossLingualHitRate ?? 0) > 0 &&
      (r.diskMb === undefined || r.diskMb < 300)
  );

  if (valid.length > 0) {
    const scored = valid
      .map((r) => ({
        r,
        score:
          (r.crossLingualHitRate ?? 0) * 0.5 +
          (r.meanP5 ?? 0) * 0.3 -
          (r.diskMb ?? 0) / 1000 * 0.2,
      }))
      .sort((a, b) => b.score - a.score);

    const best = scored[0].r;
    console.log(`\nRecommended default: ${best.modelId}`);
    console.log(`  ${best.notes}`);
    console.log(
      `  xLing=${((best.crossLingualHitRate ?? 0) * 100).toFixed(0)}%  ` +
      `meanP@5=${((best.meanP5 ?? 0) * 100).toFixed(0)}%  ` +
      `dims=${best.actualDims}  diskMb=${best.diskMb ?? "?"}  cold=${best.coldStartMs}ms`
    );
  } else {
    console.log("\nNo model cleared all thresholds. Review results above.");
  }

  console.log("\nDone.");
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
