import { homedir } from "os";
import { join, dirname } from "path";
import { readFileSync, existsSync } from "fs";
import { fileURLToPath } from "url";
import { createRequire } from "module";
import { resolveProvider, LOCAL_PROVIDER_DEFAULTS } from "./providers.js";

// Load .env (dev convenience; does NOT override existing env vars)
// Checks: cwd/.env first, then the repo root (dist/../.env) as fallback
(function loadDotEnv() {
  // __dirname equivalent in ESM
  const scriptDir = dirname(fileURLToPath(import.meta.url));
  const candidates = [
    join(process.cwd(), ".env"),
    join(scriptDir, "..", ".env"), // dist/../.env → repo root
    join(getDataDir(), ".env"),   // DATA_DIR/.env — written by `scrybe init`
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

// Read a string env var, coercing empty string to undefined.
// Callers use `||` fallback chains, so this normalises "" → undefined consistently.
function envStr(name: string): string | undefined {
  const v = process.env[name];
  return v === undefined || v === "" ? undefined : v;
}

function buildEmbeddingConfig() {
  const baseUrl = envStr("EMBEDDING_BASE_URL");
  const apiKey = envStr("EMBEDDING_API_KEY") ?? envStr("OPENAI_API_KEY");
  const localModelEnv = envStr("SCRYBE_LOCAL_EMBEDDER");
  const modelEnv = envStr("EMBEDDING_MODEL");
  const dimsEnv = envStr("EMBEDDING_DIMENSIONS");

  // Local provider: explicit SCRYBE_LOCAL_EMBEDDER, OR no URL and no API key (zero-config default)
  const isLocal = !!localModelEnv || (!baseUrl && !apiKey && !modelEnv);
  if (isLocal) {
    const model = localModelEnv ?? modelEnv ?? LOCAL_PROVIDER_DEFAULTS.model;
    const dimensions = dimsEnv ? parseInt(dimsEnv, 10) : LOCAL_PROVIDER_DEFAULTS.dimensions;
    return { baseUrl: undefined, model, dimensions, configError: null, providerType: "local" as const };
  }

  // API provider — existing logic
  const provider = resolveProvider(baseUrl);

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

  return { baseUrl, model, dimensions, configError, providerType: "api" as const };
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

  console.error(
    "[scrybe] SCRYBE_RERANK=true is set but your embedding provider does not support auto-configured reranking " +
    "(only Voyage AI is supported). Reranking is DISABLED. " +
    "Either remove SCRYBE_RERANK=true, switch to Voyage AI, or set SCRYBE_RERANK_BASE_URL + SCRYBE_RERANK_MODEL explicitly."
  );
  return { rerankEnabled: false, rerankBaseUrl: "", rerankModel: "", rerankApiKey: apiKey, rerankFetchMultiplier: fetchMultiplier };
}

function buildTextEmbeddingConfig() {
  const baseUrl =
    envStr("SCRYBE_TEXT_EMBEDDING_BASE_URL") ??
    envStr("EMBEDDING_BASE_URL") ??        // inherit from code embedding provider
    undefined;

  const provider = resolveProvider(baseUrl);

  // Inherit local provider when code embedding is also local
  const codeIsLocal = !!(envStr("SCRYBE_LOCAL_EMBEDDER") ||
    (!envStr("EMBEDDING_BASE_URL") && !envStr("EMBEDDING_API_KEY") &&
     !envStr("OPENAI_API_KEY") && !envStr("EMBEDDING_MODEL")));
  const textIsLocal = codeIsLocal && !envStr("SCRYBE_TEXT_EMBEDDING_BASE_URL");

  const model = textIsLocal
    ? (envStr("SCRYBE_TEXT_EMBEDDING_MODEL") ?? envStr("SCRYBE_LOCAL_EMBEDDER") ?? LOCAL_PROVIDER_DEFAULTS.textModel)
    : (envStr("SCRYBE_TEXT_EMBEDDING_MODEL") ?? provider?.textModel ?? "text-embedding-3-small");

  const dimsEnv = envStr("SCRYBE_TEXT_EMBEDDING_DIMENSIONS");
  const dimensions = dimsEnv
    ? parseInt(dimsEnv, 10)
    : textIsLocal
      ? LOCAL_PROVIDER_DEFAULTS.dimensions
      : (provider?.dimensions ?? 1536);

  const apiKey =
    envStr("SCRYBE_TEXT_EMBEDDING_API_KEY") ??
    envStr("EMBEDDING_API_KEY") ??
    envStr("OPENAI_API_KEY") ??
    "";

  return { baseUrl: textIsLocal ? undefined : baseUrl, model, dimensions, apiKey, providerType: textIsLocal ? "local" as const : "api" as const };
}

function buildHybridConfig() {
  const enabled = process.env.SCRYBE_HYBRID !== "false";
  const rrfK = parseInt(process.env.SCRYBE_RRF_K ?? "60", 10);
  return { hybridEnabled: enabled, rrfK };
}

const embedding = buildEmbeddingConfig();
const textEmbedding = buildTextEmbeddingConfig();
const rerank = buildRerankConfig();
const hybrid = buildHybridConfig();

function readPackageVersion(): string {
  try {
    const req = createRequire(import.meta.url);
    const pkg = req("../package.json") as { version?: string };
    return pkg.version ?? "unknown";
  } catch {
    return "unknown";
  }
}

export const VERSION = readPackageVersion();

export const config = {
  dataDir: getDataDir(),

  // Code embedding provider — local WASM or any OpenAI-compatible endpoint (EMBEDDING_* vars)
  embeddingProviderType: embedding.providerType,
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

  // Text embedding provider — for knowledge sources (SCRYBE_TEXT_EMBEDDING_* vars)
  // Falls back to code embedding config if not set separately.
  textEmbeddingProviderType: textEmbedding.providerType,
  textEmbeddingApiKey: textEmbedding.apiKey,
  textEmbeddingBaseUrl: textEmbedding.baseUrl,
  textEmbeddingModel: textEmbedding.model,
  textEmbeddingDimensions: textEmbedding.dimensions,

  // Chunker
  chunkSize: parseInt(process.env.SCRYBE_CHUNK_SIZE ?? "60", 10),
  chunkOverlap: parseInt(process.env.SCRYBE_CHUNK_OVERLAP ?? "10", 10),

  // Reranker (optional post-retrieval step)
  ...rerank,

  // Hybrid search (BM25 + vector, on by default)
  ...hybrid,
} as const;

if (config.chunkOverlap >= config.chunkSize) {
  throw new Error(
    `Invalid chunking config: SCRYBE_CHUNK_OVERLAP (${config.chunkOverlap}) must be ` +
    `less than SCRYBE_CHUNK_SIZE (${config.chunkSize}). Defaults: size=60, overlap=10.`
  );
}
