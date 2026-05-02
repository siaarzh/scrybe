import OpenAI from "openai";
import type { EmbeddingConfig } from "./types.js";
import { embedLocalBatched, embedLocalQuery } from "./local-embedder.js";

// Character limit proxy for token truncation (~4 chars/token, 8000 tokens)
const MAX_CHARS = 32_000;

/** Mutable state carried across batch iterations within a single indexing run. */
export interface HalvingSession {
  effectiveBatchSize: number;
  maxFailed: number | null;
  halved: boolean;
}

function truncate(text: string): string {
  return text.length > MAX_CHARS ? text.slice(0, MAX_CHARS) : text;
}

// Client cache keyed by "{base_url}:{api_key_env}" to avoid recreating on every call
const _clients = new Map<string, OpenAI>();

function getClient(embConfig: EmbeddingConfig): OpenAI {
  const cacheKey = `${embConfig.base_url ?? ""}:${embConfig.api_key_env}`;
  const cached = _clients.get(cacheKey);
  if (cached) return cached;

  const apiKey = process.env[embConfig.api_key_env] ?? "";
  if (!apiKey) {
    throw new Error(
      `No API key found. Set ${embConfig.api_key_env} to use model "${embConfig.model}".`
    );
  }

  const opts: ConstructorParameters<typeof OpenAI>[0] = { apiKey };
  if (embConfig.base_url) opts.baseURL = embConfig.base_url;
  const client = new OpenAI(opts);
  _clients.set(cacheKey, client);
  return client;
}

async function embedTextsOnce(texts: string[], embConfig: EmbeddingConfig): Promise<number[][]> {
  const client = getClient(embConfig);

  const response = await client.embeddings.create({
    model: embConfig.model,
    input: texts.map(truncate),
  });
  const sorted = response.data
    .sort((a, b) => a.index - b.index)
    .map((item) => item.embedding);

  // Validate dimensions on first call
  const actual = sorted[0]?.length;
  if (actual && actual !== embConfig.dimensions) {
    throw new Error(
      `Embedding model "${embConfig.model}" returned ${actual}d vectors ` +
      `but config expects ${embConfig.dimensions}d. ` +
      `Update the source's embedding dimensions config to ${actual}.`
    );
  }

  return sorted;
}

async function embedTexts(texts: string[], embConfig: EmbeddingConfig): Promise<number[][]> {
  if (texts.length === 0) return [];
  let delay = parseInt(process.env["SCRYBE_EMBED_RETRY_DELAY_MS"] ?? "5000", 10);
  for (let attempt = 0; attempt < 5; attempt++) {
    try {
      return await embedTextsOnce(texts, embConfig);
    } catch (err: unknown) {
      const status =
        (err as { status?: number })?.status ??
        (err instanceof Error && /429/.test(err.message) ? 429 : 0);
      if (status === 429 && attempt < 4) {
        await new Promise((r) => setTimeout(r, delay));
        delay *= 2;
        continue;
      }
      const body =
        (err as { error?: { message?: string } })?.error?.message ??
        (err instanceof Error ? err.message : String(err)) ??
        "(no body)";
      throw new Error(`Embedding API error (HTTP ${status || "unknown"}): ${body}`, { cause: err });
    }
  }
  /* istanbul ignore next */
  throw new Error("embedTexts: exceeded retry limit");
}

function isBatchTooLargeError(err: unknown): boolean {
  const status = (err as { status?: number })?.status;
  if (status === 400 || status === 413) return true;
  const msg = err instanceof Error ? err.message : String(err);
  return /HTTP (400|413)/.test(msg);
}

async function embedWithHalving(
  texts: string[],
  embConfig: EmbeddingConfig,
  session: HalvingSession
): Promise<number[][]> {
  try {
    return await embedTexts(texts, embConfig);
  } catch (err) {
    if (!isBatchTooLargeError(err)) throw err;

    if (texts.length === 1) {
      throw Object.assign(
        new Error("bad_chunk: single chunk rejected by embedding API"),
        { cause: err, error_type: "bad_chunk" }
      );
    }

    if (!session.halved) {
      session.maxFailed = texts.length;
      session.effectiveBatchSize = Math.max(1, Math.floor(texts.length / 2));
      session.halved = true;
    }

    const mid = Math.floor(texts.length / 2);
    const left = await embedWithHalving(texts.slice(0, mid), embConfig, session);
    const right = await embedWithHalving(texts.slice(mid), embConfig, session);
    return [...left, ...right];
  }
}

export async function embedBatched(
  texts: string[],
  embConfig: EmbeddingConfig,
  batchSize: number,
  batchDelayMs: number,
  session?: HalvingSession
): Promise<number[][]> {
  if (embConfig.provider_type === "local") {
    return embedLocalBatched(texts, { modelId: embConfig.model, dimensions: embConfig.dimensions }, batchSize);
  }
  const results: number[][] = [];
  for (let i = 0; i < texts.length; ) {
    const thisBatch = session?.effectiveBatchSize ?? batchSize;
    if (i > 0 && batchDelayMs > 0) {
      await new Promise((r) => setTimeout(r, batchDelayMs));
    }
    const batch = texts.slice(i, i + thisBatch);
    if (session) {
      results.push(...await embedWithHalving(batch, embConfig, session));
    } else {
      results.push(...await embedTexts(batch, embConfig));
    }
    i += batch.length;
  }
  return results;
}

export async function embedQuery(query: string, embConfig: EmbeddingConfig): Promise<number[]> {
  if (embConfig.provider_type === "local") {
    return embedLocalQuery(query, { modelId: embConfig.model, dimensions: embConfig.dimensions });
  }
  const [embedding] = await embedTexts([query], embConfig);
  return embedding;
}

export function resetEmbedderClientCache(): void {
  _clients.clear();
}
