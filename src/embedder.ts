import OpenAI from "openai";
import { config } from "./config.js";

// Character limit proxy for token truncation (~4 chars/token, 8000 tokens)
const MAX_CHARS = 32_000;

function truncate(text: string): string {
  return text.length > MAX_CHARS ? text.slice(0, MAX_CHARS) : text;
}

let _client: OpenAI | null = null;

function getClient(): OpenAI {
  if (!_client) {
    if (!config.embeddingApiKey) {
      throw new Error(
        "No embedding API key found. Set OPENAI_API_KEY or SCRYBE_EMBEDDING_API_KEY."
      );
    }
    const opts: ConstructorParameters<typeof OpenAI>[0] = {
      apiKey: config.embeddingApiKey,
    };
    if (config.embeddingBaseUrl) opts.baseURL = config.embeddingBaseUrl;
    _client = new OpenAI(opts);
  }
  return _client;
}

export async function embedTexts(texts: string[]): Promise<number[][]> {
  if (texts.length === 0) return [];
  const client = getClient();
  const response = await client.embeddings.create({
    model: config.embeddingModel,
    input: texts.map(truncate),
  });
  return response.data
    .sort((a, b) => a.index - b.index)
    .map((item) => item.embedding);
}

export async function embedBatched(texts: string[]): Promise<number[][]> {
  const batchSize = config.embedBatchSize;
  const results: number[][] = [];
  for (let i = 0; i < texts.length; i += batchSize) {
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
