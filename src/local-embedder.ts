/**
 * Production local WASM/ONNX embedder via @xenova/transformers.
 * In-process inference — no API key, no network call after first download.
 * Pipeline instances are cached per model ID after first load.
 */
import type { FeatureExtractionPipeline } from "@xenova/transformers";

export interface LocalEmbedderOptions {
  modelId: string;
  dimensions: number;
  /**
   * Optional asymmetric prompt templates (Plan 77 / Plan 70).
   * When set, `query` is prepended to query text and `passage` is prepended to
   * each passage text before passing to the embedding pipeline.
   * Example: { query: "query: ", passage: "passage: " } for e5-family models.
   */
  prompt_template?: { query: string; passage: string };
  /**
   * Optional char cap for truncation (Plan 77).
   * When set, input texts are truncated to this many characters before embedding.
   * Acts as a final safety net alongside the chunker-level split.
   */
  maxChars?: number;
}

// Pipeline cache keyed by modelId — shared across all call sites in the process
const _pipelines = new Map<string, FeatureExtractionPipeline>();

async function getPipeline(modelId: string): Promise<FeatureExtractionPipeline> {
  const cached = _pipelines.get(modelId);
  if (cached) return cached;
  const { pipeline } = await import("@xenova/transformers");
  const p = await pipeline("feature-extraction", modelId, { revision: "main" });
  _pipelines.set(modelId, p);
  return p;
}

function toVec(output: any, idx: number): number[] {
  return Array.from(output[idx].data as Float32Array);
}

export async function embedLocalBatched(
  texts: string[],
  opts: LocalEmbedderOptions,
  batchSize = 64
): Promise<number[][]> {
  if (texts.length === 0) return [];
  const extractor = await getPipeline(opts.modelId);
  const passagePrefix = opts.prompt_template?.passage ?? "";
  const maxChars = opts.maxChars;
  const results: number[][] = [];
  for (let i = 0; i < texts.length; i += batchSize) {
    let batch = texts.slice(i, i + batchSize);
    // Apply char cap before prefix (safety net; chunker should prevent this in most cases)
    if (maxChars !== undefined) {
      batch = batch.map((t) => t.length > maxChars ? t.slice(0, maxChars) : t);
    }
    if (passagePrefix) {
      batch = batch.map((t) => passagePrefix + t);
    }
    const output = await extractor(batch, { pooling: "mean", normalize: true });
    for (let j = 0; j < batch.length; j++) {
      results.push(toVec(output, j));
    }
  }
  return results;
}

export async function embedLocalQuery(
  query: string,
  opts: LocalEmbedderOptions
): Promise<number[]> {
  const extractor = await getPipeline(opts.modelId);
  const queryPrefix = opts.prompt_template?.query ?? "";
  const prefixedQuery = queryPrefix ? queryPrefix + query : query;
  const output = await extractor([prefixedQuery], { pooling: "mean", normalize: true });
  return toVec(output, 0);
}

/** Pre-loads the model into memory. No-op if already loaded. Call at daemon startup to avoid first-batch cold start. */
export async function warmupLocalEmbedder(opts: LocalEmbedderOptions): Promise<void> {
  if (_pipelines.has(opts.modelId)) return;
  const extractor = await getPipeline(opts.modelId);
  // Run a single inference to fully initialise the WASM runtime
  await extractor(["warmup"], { pooling: "mean", normalize: true });
}

/** Exposed for tests only — clears pipeline cache to force reload. */
export function resetLocalEmbedderCache(): void {
  _pipelines.clear();
}
