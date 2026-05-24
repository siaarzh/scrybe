/**
 * Reranker dispatch — Plan 77 Slice 5.
 *
 * Supports two backends:
 *   "http"  — HTTP endpoint (OpenAI-compatible rerank API). Original behavior.
 *   "local" — In-process cross-encoder via @xenova/transformers. Zero new deps.
 *
 * Both paths apply position-aware blending:
 *   blended = w_retrieval * normalized_rank + w_rerank * normalized_rerank_score
 *
 * Blend weights (configurable via env):
 *   SCRYBE_RERANK_BLEND_TOP3  — for candidates at original rank ≤ 3 (default "0.75,0.25")
 *   SCRYBE_RERANK_BLEND_TAIL  — for candidates at original rank ≥ 11 (default "0.40,0.60")
 *   Ranks 4-10 are linearly interpolated between the two regimes.
 */

import { config } from "./config.js";

// ─── Types ──────────────────────────────────────────────────────────────────

interface RerankResponseItem {
  index: number;
  relevance_score: number;
}

interface RerankResponse {
  data: RerankResponseItem[];
}

// ─── Local cross-encoder: pipeline component cache ─────────────────────────

interface CrossEncoderPipeline {
  tokenizer: {
    (
      texts: string[],
      opts: { text_pair?: string[]; padding: boolean; truncation: boolean }
    ): Record<string, unknown>;
  };
  model: (inputs: Record<string, unknown>) => Promise<{ logits: { ort_tensor?: unknown; data: Float32Array | number[]; dims: number[] }[] }>;
  model_config?: { id2label?: Record<string, string>; problem_type?: string };
}

// Keyed by modelId — cached across calls within the same process (same as local-embedder.ts pattern).
const _crossEncoderPipelines = new Map<string, CrossEncoderPipeline>();

// Maximum characters for the passage in a (query, passage) pair fed to the cross-encoder.
// MiniLM-L-6-v2 handles 512 tokens total; ~4 chars/token → 2048 chars combined.
// We cap the passage at 1500 chars to leave headroom for the query.
const LOCAL_RERANK_MAX_PASSAGE_CHARS = 1500;

async function getLocalPipeline(modelId: string): Promise<CrossEncoderPipeline> {
  const cached = _crossEncoderPipelines.get(modelId);
  if (cached) return cached;

  const { pipeline } = await import("@xenova/transformers");
  // text-classification loads the model + tokenizer.
  // We use the underlying tokenizer/model directly so we can pass text_pair,
  // which the TextClassificationPipeline._call() does not expose in its signature.
  const p = await pipeline("text-classification", modelId, { revision: "main" });
  const ep = p as unknown as CrossEncoderPipeline;
  _crossEncoderPipelines.set(modelId, ep);
  return ep;
}

/** Exposed for tests only — clears cross-encoder pipeline cache. */
export function resetLocalRerankCache(): void {
  _crossEncoderPipelines.clear();
}

// ─── softmax helper ────────────────────────────────────────────────────────

function softmax(arr: ArrayLike<number>): number[] {
  const nums = Array.from(arr);
  const max = Math.max(...nums);
  const exps = nums.map((x) => Math.exp(x - max));
  const sum = exps.reduce((a, b) => a + b, 0);
  return exps.map((x) => x / sum);
}

// ─── Local rerank score extraction ─────────────────────────────────────────

/**
 * Score a batch of (query, passage) pairs using the cross-encoder.
 *
 * ms-marco-MiniLM-L-6-v2 is a binary text-classification model. After softmax
 * on the two logits, the second logit (index 1) is the relevance score. We
 * return that for each input.
 *
 * Steps:
 *  1. Call tokenizer with texts (queries) + text_pair (passages).
 *  2. Call model with encoded inputs to get logits tensor.
 *  3. For each item in the batch, apply softmax and return logit[1] (positive class).
 */
async function scoreWithCrossEncoder(
  ce: CrossEncoderPipeline,
  queries: string[],
  passages: string[]
): Promise<number[]> {
  const model_inputs = ce.tokenizer(queries, {
    text_pair: passages,
    padding: true,
    truncation: true,
  });

  const outputs = await ce.model(model_inputs);

  // outputs.logits is a batched ONNX tensor with shape [batch_size, num_labels].
  //
  // ms-marco-MiniLM-L-6-v2 is a REGRESSION cross-encoder: num_labels = 1.
  // dims = [batch_size, 1] — each row has one raw relevance logit.
  // Use the raw logit directly (higher = more relevant). No softmax needed.
  //
  // Binary classification cross-encoders (num_labels = 2) use softmax on probs[1].
  // We detect the shape from dims[1] and handle both cases.
  const logitsTensor = outputs.logits as any;
  const batchSize = queries.length;
  const numLabels: number = logitsTensor.dims?.[1] ?? 1;

  // Flat data array: length = batch_size * num_labels
  const flat: number[] = Array.from(logitsTensor.data as Float32Array);

  const scores: number[] = [];
  for (let i = 0; i < batchSize; i++) {
    const rowLogits = flat.slice(i * numLabels, (i + 1) * numLabels);

    if (rowLogits.length === 0) {
      scores.push(0);
      continue;
    }

    if (numLabels === 1) {
      // Regression model — raw logit is the relevance score. Use as-is.
      // The normalization step in applyBlend handles the [min, max] rescaling.
      scores.push(rowLogits[0]!);
    } else {
      // Binary/multi-label classification — softmax, use positive class (index 1).
      const probs = softmax(rowLogits);
      scores.push(probs[1] ?? probs[0]!);
    }
  }

  return scores;
}

// ─── Local rerank implementation ────────────────────────────────────────────

async function rerankLocal<T extends { content: string; score: number }>(
  query: string,
  candidates: T[],
  topK: number,
  modelId: string,
  blendTop3: [number, number],
  blendTail: [number, number]
): Promise<T[]> {
  if (candidates.length === 0) return [];
  const crossEncoder = await getLocalPipeline(modelId);

  // Truncate passages to fit model max input (conservative char cap)
  const queries = candidates.map(() => query);
  const passages = candidates.map((c) =>
    c.content.length > LOCAL_RERANK_MAX_PASSAGE_CHARS
      ? c.content.slice(0, LOCAL_RERANK_MAX_PASSAGE_CHARS)
      : c.content
  );

  const rawScores = await scoreWithCrossEncoder(crossEncoder, queries, passages);

  // Clamp any NaN/Infinity
  const safeScores = rawScores.map((s) => (isFinite(s) ? s : 0));

  return applyBlend(candidates, safeScores, topK, blendTop3, blendTail);
}

// ─── HTTP rerank implementation (original path) ─────────────────────────────

async function rerankHttp<T extends { content: string; score: number }>(
  query: string,
  candidates: T[],
  topK: number,
  blendTop3: [number, number],
  blendTail: [number, number]
): Promise<T[]> {
  if (candidates.length === 0) return [];

  const body = {
    model: config.rerankModel,
    query,
    documents: candidates.map((r) => r.content),
    top_k: candidates.length, // fetch all so we can apply our own blending + sort
    return_documents: false,
  };

  const res = await fetch(config.rerankBaseUrl, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${config.rerankApiKey}`,
    },
    body: JSON.stringify(body),
  });

  if (!res.ok) {
    const text = await res.text().catch(() => "");
    throw new Error(`Rerank API error ${res.status}: ${text}`);
  }

  const data = (await res.json()) as RerankResponse;

  // Reconstruct the relevance scores aligned to original candidate indices
  const rerankScores = new Array<number>(candidates.length).fill(0);
  for (const item of data.data) {
    rerankScores[item.index] = item.relevance_score;
  }

  return applyBlend(candidates, rerankScores, topK, blendTop3, blendTail);
}

// ─── Position-aware blending ─────────────────────────────────────────────────

/**
 * Compute per-rank interpolated weights.
 *
 * Rank ≤ 3:  blendTop3
 * Rank ≥ 11: blendTail
 * Rank 4-10: linearly interpolated between top3 and tail.
 *
 * Returns [w_retrieval, w_rerank].
 */
function weightsForRank(
  rank: number,
  blendTop3: [number, number],
  blendTail: [number, number]
): [number, number] {
  if (rank <= 3) return blendTop3;
  if (rank >= 11) return blendTail;
  // Linear interpolation: t goes from 0 (rank=3) to 1 (rank=11)
  const t = (rank - 3) / (11 - 3);
  return [
    blendTop3[0] + t * (blendTail[0] - blendTop3[0]),
    blendTop3[1] + t * (blendTail[1] - blendTop3[1]),
  ];
}

function minMax(scores: number[]): { min: number; max: number } {
  let min = Infinity;
  let max = -Infinity;
  for (const s of scores) {
    if (s < min) min = s;
    if (s > max) max = s;
  }
  return { min, max };
}

/**
 * Apply position-aware blend and return top-K candidates sorted by blended score desc.
 *
 * @param candidates - original ordered list (rank 1 = index 0)
 * @param rerankScores - cross-encoder relevance scores aligned to candidate indices
 * @param topK - how many to return
 * @param blendTop3 - [w_retrieval, w_rerank] for rank ≤ 3
 * @param blendTail  - [w_retrieval, w_rerank] for rank ≥ 11
 */
export function applyBlend<T extends { content: string; score: number }>(
  candidates: T[],
  rerankScores: number[],
  topK: number,
  blendTop3: [number, number],
  blendTail: [number, number]
): T[] {
  const n = candidates.length;
  if (n === 0) return [];

  // Normalize rerank scores to [0, 1] across the batch
  const { min: rMin, max: rMax } = minMax(rerankScores);
  const rRange = rMax - rMin;

  const blended = candidates.map((c, i) => {
    const rank = i + 1; // 1-indexed

    // normalized_retrieval_rank: top-1 = 1.0, bottom = 0.0
    const normRank = n === 1 ? 1.0 : 1 - (rank - 1) / (n - 1);

    // normalized_rerank_score: best cross-encoder = 1.0, worst = 0.0
    const normRerank = rRange < 1e-10 ? 1.0 : (rerankScores[i]! - rMin) / rRange;

    const [wR, wX] = weightsForRank(rank, blendTop3, blendTail);
    const blendedScore = wR * normRank + wX * normRerank;

    return { candidate: c, blendedScore };
  });

  blended.sort((a, b) => b.blendedScore - a.blendedScore);

  return blended.slice(0, topK).map(({ candidate, blendedScore }) => ({
    ...candidate,
    score: blendedScore,
  }));
}

// ─── Public entry point ─────────────────────────────────────────────────────

/**
 * Rerank candidates and return top-K sorted by blended score desc.
 *
 * Dispatches to local cross-encoder or HTTP endpoint based on config.rerankProviderType.
 * Both paths apply position-aware blending (Plan 77 Slice 5).
 */
export async function rerank<T extends { content: string; score: number }>(
  query: string,
  candidates: T[],
  topK: number
): Promise<T[]> {
  const blendTop3 = config.rerankBlendTop3;
  const blendTail = config.rerankBlendTail;

  if (config.rerankProviderType === "local") {
    const modelId = config.rerankModel || "Xenova/ms-marco-MiniLM-L-6-v2";
    return rerankLocal(query, candidates, topK, modelId, blendTop3, blendTail);
  }

  return rerankHttp(query, candidates, topK, blendTop3, blendTail);
}
