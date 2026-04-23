/**
 * Production local WASM/ONNX embedder via @xenova/transformers.
 * In-process inference — no API key, no network call after first download.
 * Pipeline instances are cached per model ID after first load.
 */
import type { FeatureExtractionPipeline } from "@xenova/transformers";

export interface LocalEmbedderOptions {
  modelId: string;
  dimensions: number;
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
  const results: number[][] = [];
  for (let i = 0; i < texts.length; i += batchSize) {
    const batch = texts.slice(i, i + batchSize);
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
  const output = await extractor([query], { pooling: "mean", normalize: true });
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
