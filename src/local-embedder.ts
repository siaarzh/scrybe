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

/**
 * A loaded pipeline plus the model metadata the batching planner needs.
 * `maxSeqTokens` is the tokenizer's own `model_max_length` — the point at which
 * the feature-extraction pipeline truncates internally (it hardcodes
 * `truncation: true`), so it is also the largest padded sequence length any
 * forward pass can ever see.
 */
interface LoadedModel {
  extractor: FeatureExtractionPipeline;
  maxSeqTokens: number;
}

// Pipeline cache keyed by modelId — shared across all call sites in the process
const _pipelines = new Map<string, LoadedModel>();

/** Fallback when a tokenizer does not declare `model_max_length`. */
const FALLBACK_MAX_SEQ_TOKENS = 512;

/**
 * Ceiling on a tokenizer's self-declared `model_max_length`. Long-context
 * embedding models top out well below this; anything above it is a sentinel or
 * a bad config, and trusting it would disable the batch budget entirely.
 */
const MAX_TRUSTED_SEQ_TOKENS = 8192;

/**
 * Upper bound on source characters a single token may consume, used to turn the
 * model's token limit into a character cap.
 *
 * The default model's tokenizer (Xenova/multilingual-e5-small, a 250k-piece
 * SentencePiece vocabulary) has a longest vocabulary piece of 16 characters, so
 * `maxSeqTokens` tokens can never span more than 16x that many non-whitespace
 * characters. 64 keeps a 4x margin for normalisation forms that fold several
 * source characters onto one piece.
 */
const MAX_CHARS_PER_TOKEN = 64;

/**
 * Total padded token slots (rows x padded sequence length) allowed in a single
 * forward pass. Peak RSS is linear in this product at roughly 33 KB per slot,
 * so an unbounded batch of 64 rows padded to 512 tokens costs ~1 GB while a
 * 4096-slot budget costs ~140 MB.
 */
const DEFAULT_TOKEN_BUDGET = 4096;

function resolveTokenBudget(maxSeqTokens: number): number {
  const raw = process.env["SCRYBE_LOCAL_EMBED_TOKEN_BUDGET"];
  const parsed = raw === undefined ? NaN : Number(raw);
  const budget = Number.isFinite(parsed) && parsed > 0 ? Math.floor(parsed) : DEFAULT_TOKEN_BUDGET;
  // A budget below one full-length row would stall the planner — a single row
  // always goes through regardless, so floor it at one row.
  return Math.max(budget, maxSeqTokens);
}

/**
 * Truncates `text` so the tokenizer never has to scan an unbounded string.
 *
 * The budget is spent on non-whitespace characters only. Runs of whitespace
 * collapse to a single token in this tokenizer family (20,000 spaces tokenize to
 * one token), so charging them against the budget would be the one way a cap
 * could drop content the model would otherwise have seen. `rawLimit` still bounds
 * the scan itself so a pathological whitespace-only input cannot cost unbounded
 * work.
 *
 * Because `maxNonWsChars` is derived from `maxSeqTokens * MAX_CHARS_PER_TOKEN`,
 * any text this cuts was already past the model's token limit and would have
 * been truncated by the tokenizer anyway — the resulting token sequence, and so
 * the embedding, is unchanged.
 */
export function truncateForModel(text: string, maxNonWsChars: number): string {
  if (text.length <= maxNonWsChars) return text;
  let nonWs = 0;
  let lastNonWs = -1;
  for (let i = 0; i < text.length; i++) {
    const c = text.charCodeAt(i);
    // space, tab, LF, CR, VT, FF, NBSP — the common collapsing whitespace
    const isWs = c === 32 || (c >= 9 && c <= 13) || c === 160;
    if (isWs) continue;
    if (++nonWs > maxNonWsChars) return text.slice(0, i);
    lastNonWs = i;
  }

  // The budget was never exhausted, so the model will see every real character
  // in this text. The only thing left to bound is whitespace, and the governing
  // rule is: NEVER drop a non-whitespace character; cap only what trails past
  // the last one.
  //
  // Both halves of that rule are load-bearing and each has a test. An earlier
  // version stopped scanning at `maxNonWsChars * 8` and cut there, which
  // silently defeated the whitespace exemption this function exists for —
  // "start" + 20k spaces + "end" lost the "end". Removing the cap outright then
  // let a pure-whitespace input through whole. Keeping content through
  // `lastNonWs` satisfies both: real text is never lost, and a
  // whitespace-only input still collapses to the ceiling.
  //
  // The scan itself is deliberately uncapped: one charCodeAt pass is orders of
  // magnitude cheaper than the tokenization it precedes.
  const ceiling = maxNonWsChars * 8;
  if (text.length <= ceiling) return text;
  return text.slice(0, Math.max(lastNonWs + 1, ceiling));
}

/**
 * Groups indices of `texts` into forward passes that each stay within `budget`
 * padded token slots.
 *
 * Texts are visited shortest-first so that rows sharing a pass have similar
 * lengths, which keeps padding — and therefore the padded sequence length that
 * sets the cost — near the true length of the rows in it.
 *
 * The per-row estimate is `length + 2` (the text plus two special tokens). That
 * is a good estimate, NOT a strict upper bound, and the difference matters:
 *
 * - It can under-count. A tokenizer that emits more than one token per JS
 *   character exceeds it — measured against the shipped SentencePiece model,
 *   1,000 CJK characters produce 1,003 tokens, and a byte-fallback BPE
 *   tokenizer can emit three or four tokens per character for CJK or emoji.
 * - It is bounded anyway. Each row is clamped at `maxSeqTokens` before it
 *   counts against the budget, so a pass can never exceed
 *   `rows x maxSeqTokens` slots no matter how wrong the estimate is. An
 *   under-count inflates a pass, it does not make it unbounded.
 *
 * So the budget is a soft target that holds exactly for ASCII-dominant text and
 * degrades gracefully elsewhere. If a future model ships a tokenizer with a very
 * different character-to-token ratio, re-measure rather than assuming this still
 * holds.
 */
export function planMicroBatches(texts: string[], maxSeqTokens: number, budget: number): number[][] {
  const estTokens = (t: string): number => Math.min(maxSeqTokens, t.length + 2);
  const order = texts.map((_, i) => i).sort((a, b) => estTokens(texts[a]!) - estTokens(texts[b]!));
  const groups: number[][] = [];
  let i = 0;
  while (i < order.length) {
    let paddedLen = 0;
    let n = 0;
    while (i + n < order.length) {
      const next = Math.max(paddedLen, estTokens(texts[order[i + n]!]!));
      // Always admit the first row, even if it alone exceeds the budget.
      if (n > 0 && next * (n + 1) > budget) break;
      paddedLen = next;
      n++;
    }
    groups.push(order.slice(i, i + n));
    i += n;
  }
  return groups;
}

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
): Promise<LoadedModel> {
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
  const declared = Number((p as { tokenizer?: { model_max_length?: unknown } }).tokenizer?.model_max_length);
  // A finite, positive `model_max_length` is NOT enough to trust it. When a
  // tokenizer declares no real limit, HuggingFace's convention is the sentinel
  // 1000000000000000019884624838656 — finite and positive, so a naive check
  // accepts it. That would set the budget to the sentinel, put every row in one
  // forward pass, and lift the char backstop out of reach: both halves of this
  // memory fix would silently revert to the multi-GB behaviour they exist to
  // prevent, with nothing in the log to say so. Clamp to a value no real
  // sentence-embedding model exceeds.
  const maxSeqTokens = Number.isFinite(declared) && declared > 0
    ? Math.min(declared, MAX_TRUSTED_SEQ_TOKENS)
    : FALLBACK_MAX_SEQ_TOKENS;
  const loaded: LoadedModel = { extractor: p, maxSeqTokens };
  _pipelines.set(modelId, loaded);
  return loaded;
}

/**
 * Applies both length caps to one text.
 *
 * `optsMaxChars` (the configured `max_input_tokens * 4`) keeps its original raw
 * slice semantics so texts already capped by config embed exactly as before.
 * The model-derived backstop then bounds anything left — it is inert whenever a
 * config cap is set, and is the only bound on presets that omit
 * `max_input_tokens` and on sources that bypass the code chunker.
 */
function capText(text: string, optsMaxChars: number | undefined, maxSeqTokens: number): string {
  const capped = optsMaxChars !== undefined && text.length > optsMaxChars
    ? text.slice(0, optsMaxChars)
    : text;
  return truncateForModel(capped, maxSeqTokens * MAX_CHARS_PER_TOKEN);
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
  const { extractor, maxSeqTokens } = await getPipeline(opts.modelId, onDownloadProgress);
  const passagePrefix = opts.prompt_template?.passage ?? "";
  const budget = resolveTokenBudget(maxSeqTokens);
  const results: number[][] = new Array(texts.length);
  for (let i = 0; i < texts.length; i += batchSize) {
    // Apply char cap before prefix (safety net; chunker should prevent this in most cases)
    const batch = texts.slice(i, i + batchSize).map((t) => {
      const capped = capText(t, opts.maxChars, maxSeqTokens);
      return passagePrefix ? passagePrefix + capped : capped;
    });
    // One oversized text pads the whole batch up to the model's sequence limit,
    // and cost is the padded rectangle — so split into length-similar passes
    // that each stay inside the token budget rather than sending all rows at once.
    for (const group of planMicroBatches(batch, maxSeqTokens, budget)) {
      const output = await extractor(group.map((k) => batch[k]!), { pooling: "mean", normalize: true });
      for (let j = 0; j < group.length; j++) {
        results[i + group[j]!] = toVec(output, j);
      }
    }
  }
  return results;
}

export async function embedLocalQuery(
  query: string,
  opts: LocalEmbedderOptions
): Promise<number[]> {
  const { extractor, maxSeqTokens } = await getPipeline(opts.modelId);
  const queryPrefix = opts.prompt_template?.query ?? "";
  // A single text cannot be padded by a batch-mate, but an over-long query is
  // still an unbounded string for the tokenizer to scan.
  const capped = capText(query, opts.maxChars, maxSeqTokens);
  const prefixedQuery = queryPrefix ? queryPrefix + capped : capped;
  const output = await extractor([prefixedQuery], { pooling: "mean", normalize: true });
  return toVec(output, 0);
}

/** Pre-loads the model into memory. No-op if already loaded. Call at daemon startup to avoid first-batch cold start. */
export async function warmupLocalEmbedder(opts: LocalEmbedderOptions): Promise<void> {
  if (_pipelines.has(opts.modelId)) return;
  const { extractor } = await getPipeline(opts.modelId);
  // Run a single inference to fully initialise the WASM runtime
  await extractor(["warmup"], { pooling: "mean", normalize: true });
}

/** Exposed for tests only — clears pipeline cache to force reload. */
export function resetLocalEmbedderCache(): void {
  _pipelines.clear();
}
