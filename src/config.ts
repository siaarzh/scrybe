import { homedir } from "os";
import { join, dirname } from "path";
import { readFileSync, existsSync } from "fs";
import { fileURLToPath } from "url";
import { resolveProvider } from "./providers.js";

// Load .env (dev convenience; does NOT override existing env vars)
// Checks: cwd/.env first, then the repo root (dist/../.env) as fallback
(function loadDotEnv() {
  // __dirname equivalent in ESM
  const scriptDir = dirname(fileURLToPath(import.meta.url));
  const candidates = [
    join(process.cwd(), ".env"),
    join(scriptDir, "..", ".env"), // dist/../.env → repo root
  ];
  for (const p of candidates) {
    if (!existsSync(p)) continue;
    try {
      for (const line of readFileSync(p, "utf8").split("\n")) {
        const trimmed = line.trim();
        if (!trimmed || trimmed.startsWith("#")) continue;
        const eq = trimmed.indexOf("=");
        if (eq === -1) continue;
        const key = trimmed.slice(0, eq).trim();
        const val = trimmed.slice(eq + 1).trim();
        if (key && !(key in process.env)) process.env[key] = val;
      }
      break;
    } catch { /* ignore */ }
  }
})();

function getDataDir(): string {
  if (process.env.SCRYBE_DATA_DIR) return process.env.SCRYBE_DATA_DIR;
  const home = homedir();
  if (process.platform === "win32") {
    const localAppData = process.env.LOCALAPPDATA ?? join(home, "AppData", "Local");
    return join(localAppData, "scrybe", "scrybe");
  } else if (process.platform === "darwin") {
    return join(home, "Library", "Application Support", "scrybe");
  } else {
    const xdgData = process.env.XDG_DATA_HOME ?? join(home, ".local", "share");
    return join(xdgData, "scrybe");
  }
}

function buildEmbeddingConfig() {
  const baseUrl = process.env.EMBEDDING_BASE_URL ?? undefined;
  const provider = resolveProvider(baseUrl);

  const modelEnv = process.env.EMBEDDING_MODEL;
  const dimsEnv = process.env.EMBEDDING_DIMENSIONS;

  // Unknown provider with no explicit model — surface a helpful config error
  let configError: string | null = null;
  if (!provider && !modelEnv) {
    const modelsUrl = baseUrl ? `${baseUrl.replace(/\/$/, "")}/models` : null;
    configError =
      `Unknown embedding provider for base URL "${baseUrl}". ` +
      `EMBEDDING_MODEL is not set. ` +
      (modelsUrl
        ? `Fetch ${modelsUrl} to list available models, pick an embedding model, ` +
          `then set EMBEDDING_MODEL and EMBEDDING_DIMENSIONS in your config.`
        : `Set EMBEDDING_MODEL and EMBEDDING_DIMENSIONS in your config.`);
  }

  const model = modelEnv ?? provider?.model ?? "text-embedding-3-small";
  const dimensions = dimsEnv
    ? parseInt(dimsEnv, 10)
    : (provider?.dimensions ?? 1536);

  return { baseUrl, model, dimensions, configError };
}

function buildRerankConfig() {
  const enabled = process.env.SCRYBE_RERANK === "true";
  const apiKey =
    process.env.SCRYBE_RERANK_API_KEY ??
    process.env.EMBEDDING_API_KEY ??
    process.env.OPENAI_API_KEY ??
    "";
  const fetchMultiplier = parseInt(
    process.env.SCRYBE_RERANK_FETCH_MULTIPLIER ?? "5",
    10
  );

  if (!enabled) {
    return { rerankEnabled: false, rerankBaseUrl: "", rerankModel: "", rerankApiKey: apiKey, rerankFetchMultiplier: fetchMultiplier };
  }

  // Explicit custom provider
  const explicitUrl = process.env.SCRYBE_RERANK_BASE_URL;
  if (explicitUrl) {
    const model = process.env.SCRYBE_RERANK_MODEL ?? "";
    if (!model) {
      console.error("[scrybe] SCRYBE_RERANK_BASE_URL is set but SCRYBE_RERANK_MODEL is missing. Reranking disabled.");
      return { rerankEnabled: false, rerankBaseUrl: "", rerankModel: "", rerankApiKey: apiKey, rerankFetchMultiplier: fetchMultiplier };
    }
    return { rerankEnabled: true, rerankBaseUrl: explicitUrl, rerankModel: model, rerankApiKey: apiKey, rerankFetchMultiplier: fetchMultiplier };
  }

  // Auto-detect Voyage from embedding provider
  const embeddingBaseUrl = process.env.EMBEDDING_BASE_URL ?? undefined;
  const provider = resolveProvider(embeddingBaseUrl);
  if (provider?.name === "Voyage AI") {
    return {
      rerankEnabled: true,
      rerankBaseUrl: "https://api.voyageai.com/v1/rerank",
      rerankModel: process.env.SCRYBE_RERANK_MODEL ?? "rerank-2.5",
      rerankApiKey: apiKey,
      rerankFetchMultiplier: fetchMultiplier,
    };
  }

  console.error("[scrybe] SCRYBE_RERANK=true but could not resolve a reranker (set SCRYBE_RERANK_BASE_URL + SCRYBE_RERANK_MODEL, or use Voyage as embedding provider). Reranking disabled.");
  return { rerankEnabled: false, rerankBaseUrl: "", rerankModel: "", rerankApiKey: apiKey, rerankFetchMultiplier: fetchMultiplier };
}

const embedding = buildEmbeddingConfig();
const rerank = buildRerankConfig();

export const config = {
  dataDir: getDataDir(),

  // Embedding provider — any OpenAI-compatible endpoint
  embeddingApiKey:
    process.env.EMBEDDING_API_KEY ??
    process.env.OPENAI_API_KEY ??
    "",
  embeddingBaseUrl: embedding.baseUrl,
  embeddingModel: embedding.model,
  embeddingDimensions: embedding.dimensions,
  embeddingConfigError: embedding.configError,
  embedBatchSize: parseInt(process.env.EMBED_BATCH_SIZE ?? "100", 10),
  embedBatchDelayMs: parseInt(process.env.EMBED_BATCH_DELAY_MS ?? "0", 10),

  // Chunker
  chunkSize: parseInt(process.env.SCRYBE_CHUNK_SIZE ?? "60", 10),
  chunkOverlap: parseInt(process.env.SCRYBE_CHUNK_OVERLAP ?? "10", 10),

  // Reranker (optional post-retrieval step)
  ...rerank,
} as const;
