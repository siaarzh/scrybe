import OpenAI from "openai";
import { config } from "./config.js";

// Character limit proxy for token truncation (~4 chars/token, 8000 tokens)
const MAX_CHARS = 32_000;

function truncate(text: string): string {
  return text.length > MAX_CHARS ? text.slice(0, MAX_CHARS) : text;
}

let _client: OpenAI | null = null;

function getClient(): OpenAI {
  if (_client) return _client;
  if (config.embeddingConfigError) {
    throw new Error(config.embeddingConfigError);
  }
  if (!config.embeddingApiKey) {
    throw new Error(
      "No embedding API key found. Set EMBEDDING_API_KEY or OPENAI_API_KEY."
    );
  }
  const opts: ConstructorParameters<typeof OpenAI>[0] = {
    apiKey: config.embeddingApiKey,
  };
  if (config.embeddingBaseUrl) opts.baseURL = config.embeddingBaseUrl;
  _client = new OpenAI(opts);
  return _client;
}

async function embedTextsOnce(texts: string[]): Promise<number[][]> {
  const client = getClient();
  const response = await client.embeddings.create({
    model: config.embeddingModel,
    input: texts.map(truncate),
  });
  const sorted = response.data
    .sort((a, b) => a.index - b.index)
    .map((item) => item.embedding);

  // Validate dimensions on first call — catches misconfigured EMBEDDING_DIMENSIONS
  const actual = sorted[0]?.length;
  if (actual && actual !== config.embeddingDimensions) {
    throw new Error(
      `Embedding model "${config.embeddingModel}" returned ${actual}d vectors ` +
      `but EMBEDDING_DIMENSIONS is set to ${config.embeddingDimensions}. ` +
      `Update EMBEDDING_DIMENSIONS=${actual} in your config.`
    );
  }

  return sorted;
}

export async function embedTexts(texts: string[]): Promise<number[][]> {
  if (texts.length === 0) return [];
  let delay = 5_000;
  for (let attempt = 0; attempt < 5; attempt++) {
    try {
      return await embedTextsOnce(texts);
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

export async function embedBatched(texts: string[]): Promise<number[][]> {
  const batchSize = config.embedBatchSize;
  const batchDelay = config.embedBatchDelayMs;
  const results: number[][] = [];
  for (let i = 0; i < texts.length; i += batchSize) {
    if (i > 0 && batchDelay > 0) {
      await new Promise((r) => setTimeout(r, batchDelay));
    }
    const batch = texts.slice(i, i + batchSize);
    const embeddings = await embedTexts(batch);
    results.push(...embeddings);
  }
  return results;
}

export async function embedQuery(query: string): Promise<number[]> {
  const [embedding] = await embedTexts([query]);
  return embedding;
}
