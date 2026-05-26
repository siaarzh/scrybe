/**
 * Production local WASM/ONNX embedder via @xenova/transformers.
 * In-process inference — no API key, no network call after first download.
 * Pipeline instances are cached per model ID after first load.
 */
import { existsSync } from "fs";
import { join } from "path";
import type { FeatureExtractionPipeline } from "@xenova/transformers";
import { getTransformers, resolveModelCacheDir } from "./util/transformers-loader.js";

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

/**
 * Returns true if the model is already loaded in-process OR its files are present
 * in the on-disk cache (i.e. no network download would be needed).
 * Used by the search path to fail fast rather than silently trigger a download.
 */
export function isLocalModelCached(modelId: string): boolean {
  if (_pipelines.has(modelId)) return true;
  // @xenova/transformers stores models at <cacheDir>/<modelId>/config.json.
  // modelId may contain a "/" (e.g. "Xenova/multilingual-e5-small").
  const configPath = join(resolveModelCacheDir(), modelId, "config.json");
  return existsSync(configPath);
}

/** Progress event fired by @xenova/transformers during model download. */
export interface ModelDownloadProgress {
  /** 0-100, aggregated across all files being downloaded. */
  percent: number;
}

async function getPipeline(
  modelId: string,
  onDownloadProgress?: (progress: ModelDownloadProgress) => void,
): Promise<FeatureExtractionPipeline> {
  const cached = _pipelines.get(modelId);
  if (cached) return cached;
  const { pipeline } = await getTransformers();

  // Track per-file byte progress to compute an aggregate percent across the
  // multi-file model download. @xenova/transformers fires `progress` events
  // while streaming each file's bytes (with `loaded`/`total`); `done`/`ready`
  // are lifecycle markers without byte data. We weight by bytes — not by a
  // mean of per-file ratios — so the multi-MB ONNX weights dominate and tiny
  // sidecar files (config.json, tokenizer.json) can't pin the percent to 100.
  // Until the cumulative size crosses a floor we stay silent, so a tiny file
  // that completes before the weights start downloading doesn't report 100%.
  const MIN_REPORT_BYTES = 1_000_000;
  let lastReported = -1;
  const fileProgress = new Map<string, { loaded: number; total: number }>();

  const progress_callback = onDownloadProgress
    ? (event: { status: string; file?: string; loaded?: number; total?: number; progress?: number }) => {
        if (event.status === "progress" && event.file && typeof event.total === "number" && event.total > 0) {
          fileProgress.set(event.file, { loaded: event.loaded ?? 0, total: event.total });
          let sumLoaded = 0;
          let sumTotal = 0;
          for (const { loaded, total } of fileProgress.values()) {
            sumLoaded += loaded;
            sumTotal += total;
          }
          if (sumTotal < MIN_REPORT_BYTES) return; // tiny-files-only window — not meaningful yet
          // Cap at 99 during download; the job flips to the "embedding" phase
          // (clearing percent) once the model is loaded, which signals 100%.
          const newPercent = Math.min(99, Math.round((sumLoaded / sumTotal) * 100));
          if (newPercent !== lastReported) {
            lastReported = newPercent;
            onDownloadProgress({ percent: newPercent });
          }
        }
      }
    : undefined;

  const pipelineOpts: Record<string, unknown> = { revision: "main" };
  if (progress_callback) pipelineOpts["progress_callback"] = progress_callback;

  let p: FeatureExtractionPipeline;
  try {
    p = await pipeline("feature-extraction", modelId, pipelineOpts as Parameters<typeof pipeline>[2]);
  } catch (err: unknown) {
    // Tag the error so callers (e.g. jobs.ts) can apply the user-friendly classifier.
    (err as any).error_type = "local_model_load";
    throw err;
  }
  _pipelines.set(modelId, p);
  return p;
}

function toVec(output: any, idx: number): number[] {
  return Array.from(output[idx].data as Float32Array);
}

export async function embedLocalBatched(
  texts: string[],
  opts: LocalEmbedderOptions,
  batchSize = 64,
  onDownloadProgress?: (progress: ModelDownloadProgress) => void,
): Promise<number[][]> {
  if (texts.length === 0) return [];
  const extractor = await getPipeline(opts.modelId, onDownloadProgress);
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
