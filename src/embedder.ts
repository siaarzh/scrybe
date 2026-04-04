import OpenAI from "openai";
import { config } from "./config.js";

export type EmbeddingProfile = "code" | "text";

// Character limit proxy for token truncation (~4 chars/token, 8000 tokens)
const MAX_CHARS = 32_000;

function truncate(text: string): string {
  return text.length > MAX_CHARS ? text.slice(0, MAX_CHARS) : text;
}

// Per-profile OpenAI client singletons
const _clients: Partial<Record<EmbeddingProfile, OpenAI>> = {};

function getClient(profile: EmbeddingProfile = "code"): OpenAI {
  if (_clients[profile]) return _clients[profile]!;

  if (profile === "code") {
    if (config.embeddingConfigError) throw new Error(config.embeddingConfigError);
    if (!config.embeddingApiKey) {
      throw new Error("No embedding API key found. Set EMBEDDING_API_KEY or OPENAI_API_KEY.");
    }
    const opts: ConstructorParameters<typeof OpenAI>[0] = { apiKey: config.embeddingApiKey };
    if (config.embeddingBaseUrl) opts.baseURL = config.embeddingBaseUrl;
    _clients.code = new OpenAI(opts);
    return _clients.code;
  }

  // text profile
  if (!config.textEmbeddingApiKey) {
    throw new Error(
      "No text embedding API key found. Set SCRYBE_TEXT_EMBEDDING_API_KEY, EMBEDDING_API_KEY, or OPENAI_API_KEY."
    );
  }
  const opts: ConstructorParameters<typeof OpenAI>[0] = { apiKey: config.textEmbeddingApiKey };
  if (config.textEmbeddingBaseUrl) opts.baseURL = config.textEmbeddingBaseUrl;
  _clients.text = new OpenAI(opts);
  return _clients.text;
}

function getModel(profile: EmbeddingProfile): string {
  return profile === "code" ? config.embeddingModel : config.textEmbeddingModel;
}

function getDimensions(profile: EmbeddingProfile): number {
  return profile === "code" ? config.embeddingDimensions : config.textEmbeddingDimensions;
}

async function embedTextsOnce(texts: string[], profile: EmbeddingProfile): Promise<number[][]> {
  const client = getClient(profile);
  const model = getModel(profile);
  const expectedDims = getDimensions(profile);

  const response = await client.embeddings.create({
    model,
    input: texts.map(truncate),
  });
  const sorted = response.data
    .sort((a, b) => a.index - b.index)
    .map((item) => item.embedding);

  // Validate dimensions on first call
  const actual = sorted[0]?.length;
  if (actual && actual !== expectedDims) {
    const envVar = profile === "code" ? "EMBEDDING_DIMENSIONS" : "SCRYBE_TEXT_EMBEDDING_DIMENSIONS";
    throw new Error(
      `Embedding model "${model}" returned ${actual}d vectors ` +
      `but ${envVar} is set to ${expectedDims}. ` +
      `Update ${envVar}=${actual} in your config.`
    );
  }

  return sorted;
}

export async function embedTexts(texts: string[], profile: EmbeddingProfile = "code"): Promise<number[][]> {
  if (texts.length === 0) return [];
  let delay = 5_000;
  for (let attempt = 0; attempt < 5; attempt++) {
    try {
      return await embedTextsOnce(texts, profile);
    } catch (err: unknown) {
      const status =
        (err as { status?: number })?.status ??
        (err instanceof Error && /429/.test(err.message) ? 429 : 0);
      if (status === 429 && attempt < 4) {
        await new Promise((r) => setTimeout(r, delay));
        delay *= 2;
        continue;
      }
      throw err;
    }
  }
  /* istanbul ignore next */
  throw new Error("embedTexts: exceeded retry limit");
}

export async function embedBatched(texts: string[], profile: EmbeddingProfile = "code"): Promise<number[][]> {
  const batchSize = config.embedBatchSize;
  const batchDelay = config.embedBatchDelayMs;
  const results: number[][] = [];
  for (let i = 0; i < texts.length; i += batchSize) {
    if (i > 0 && batchDelay > 0) {
      await new Promise((r) => setTimeout(r, batchDelay));
    }
    const batch = texts.slice(i, i + batchSize);
    const embeddings = await embedTexts(batch, profile);
    results.push(...embeddings);
  }
  return results;
}

export async function embedQuery(query: string, profile: EmbeddingProfile = "code"): Promise<number[]> {
  const [embedding] = await embedTexts([query], profile);
  return embedding;
}
