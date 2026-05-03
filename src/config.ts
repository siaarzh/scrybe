import { homedir } from "os";
import { join } from "path";
import { readFileSync, writeFileSync, existsSync } from "fs";
import { createRequire } from "module";
import { resolveProvider, LOCAL_PROVIDER_DEFAULTS } from "./providers.js";

/** Map of old env var name → new env var name (for .env file rewriting at load time). */
const ENV_RENAME_MAP_INTERNAL: Record<string, string> = {
  "EMBEDDING_BASE_URL":      "SCRYBE_CODE_EMBEDDING_BASE_URL",
  "EMBEDDING_API_KEY":       "SCRYBE_CODE_EMBEDDING_API_KEY",
  "EMBEDDING_MODEL":         "SCRYBE_CODE_EMBEDDING_MODEL",
  "EMBEDDING_DIMENSIONS":    "SCRYBE_CODE_EMBEDDING_DIMENSIONS",
  "EMBED_BATCH_SIZE":        "SCRYBE_EMBED_BATCH_SIZE",
  "EMBED_BATCH_DELAY_MS":    "SCRYBE_EMBED_BATCH_DELAY_MS",
  "SCRYBE_TEXT_EMBEDDING_BASE_URL":   "SCRYBE_KNOWLEDGE_EMBEDDING_BASE_URL",
  "SCRYBE_TEXT_EMBEDDING_API_KEY":    "SCRYBE_KNOWLEDGE_EMBEDDING_API_KEY",
  "SCRYBE_TEXT_EMBEDDING_MODEL":      "SCRYBE_KNOWLEDGE_EMBEDDING_MODEL",
  "SCRYBE_TEXT_EMBEDDING_DIMENSIONS": "SCRYBE_KNOWLEDGE_EMBEDDING_DIMENSIONS",
};

/**
 * Load DATA_DIR/.env into process.env. OS env always takes precedence.
 *
 * Fix 1 (Plan 31): Also applies ENV_RENAME_MAP inline so env-rename happens
 * BEFORE buildRerankConfig() evaluates — preventing a spurious "not Voyage"
 * warning on first run after upgrade. The rewrite is idempotent: once new keys
 * are in the file the old names are gone and no change is written.
 */
(function loadDotEnv() {
  const p = join(getDataDir(), ".env");
  if (!existsSync(p)) return;

  let content: string;
  try {
    content = readFileSync(p, "utf8");
  } catch { return; }

  const rawLines = content.split("\n");
  const keysPresent = new Set<string>();
  type Parsed = { key: string; value: string; raw: string };
  const parsed: Parsed[] = [];

  for (const raw of rawLines) {
    const trimmed = raw.trim();
    if (!trimmed || trimmed.startsWith("#")) {
      parsed.push({ key: "", value: "", raw });
      continue;
    }
    const eq = trimmed.indexOf("=");
    if (eq === -1) { parsed.push({ key: "", value: "", raw }); continue; }
    const key = trimmed.slice(0, eq).trim();
    const value = trimmed.slice(eq + 1).trim();
    parsed.push({ key, value, raw });
    if (key) keysPresent.add(key);
  }

  // Apply rename map — rewrite .env in place if anything changed.
  const renamedKeys = new Set<string>();
  const newLines: string[] = [];
  let changed = false;

  for (const entry of parsed) {
    if (!entry.key) { newLines.push(entry.raw); continue; }
    const newName = ENV_RENAME_MAP_INTERNAL[entry.key];
    if (newName) {
      if (!keysPresent.has(newName) && !renamedKeys.has(newName)) {
        newLines.push(`${newName}=${entry.value}`);
        renamedKeys.add(newName);
        process.stderr.write(`[scrybe] migration: renamed ${entry.key} → ${newName} in .env\n`);
      } else {
        process.stderr.write(`[scrybe] migration: dropped duplicate ${entry.key} (${newName} already present)\n`);
      }
      changed = true;
    } else {
      newLines.push(entry.raw);
    }
  }

  if (changed) {
    try {
      writeFileSync(p, newLines.join("\n"), "utf8");
    } catch (e) {
      process.stderr.write(`[scrybe] migration: could not rewrite .env: ${e}\n`);
    }
    // Set renamed keys into process.env for this run
    for (const [oldKey, newKey] of Object.entries(ENV_RENAME_MAP_INTERNAL)) {
      if (renamedKeys.has(newKey) && !(newKey in process.env)) {
        if (oldKey in process.env) {
          process.env[newKey] = process.env[oldKey];
        }
      }
    }
  }

  // Warn if OPENAI_API_KEY is the only auth source in .env (not replaced by explicit key).
  if (keysPresent.has("OPENAI_API_KEY") && !keysPresent.has("EMBEDDING_API_KEY") && !keysPresent.has("SCRYBE_CODE_EMBEDDING_API_KEY")) {
    process.stderr.write(
      "[scrybe] migration: OPENAI_API_KEY fallback is removed. " +
      "Set SCRYBE_CODE_EMBEDDING_API_KEY explicitly in your .env.\n"
    );
  }

  // Apply all (now-renamed) lines to process.env — OS env takes precedence.
  const finalLines = changed ? newLines : rawLines;
  for (const line of finalLines) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;
    const eq = trimmed.indexOf("=");
    if (eq === -1) continue;
    const key = trimmed.slice(0, eq).trim();
    const val = trimmed.slice(eq + 1).trim();
    if (key && !(key in process.env)) process.env[key] = val;
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

// Old env var names that were renamed in this release. Used at startup to warn
// users who still have them in their OS env or MCP server config.
const OLD_ENV_VAR_MAP: Record<string, string> = {
  "EMBEDDING_BASE_URL":      "SCRYBE_CODE_EMBEDDING_BASE_URL",
  "EMBEDDING_API_KEY":       "SCRYBE_CODE_EMBEDDING_API_KEY",
  "EMBEDDING_MODEL":         "SCRYBE_CODE_EMBEDDING_MODEL",
  "EMBEDDING_DIMENSIONS":    "SCRYBE_CODE_EMBEDDING_DIMENSIONS",
  "EMBED_BATCH_SIZE":        "SCRYBE_EMBED_BATCH_SIZE",
  "EMBED_BATCH_DELAY_MS":    "SCRYBE_EMBED_BATCH_DELAY_MS",
  "SCRYBE_TEXT_EMBEDDING_BASE_URL":   "SCRYBE_KNOWLEDGE_EMBEDDING_BASE_URL",
  "SCRYBE_TEXT_EMBEDDING_API_KEY":    "SCRYBE_KNOWLEDGE_EMBEDDING_API_KEY",
  "SCRYBE_TEXT_EMBEDDING_MODEL":      "SCRYBE_KNOWLEDGE_EMBEDDING_MODEL",
  "SCRYBE_TEXT_EMBEDDING_DIMENSIONS": "SCRYBE_KNOWLEDGE_EMBEDDING_DIMENSIONS",
};

/**
 * Warn about old env var names that are set in process.env but can't be rewritten
 * by the .env migration (they came from OS env or MCP server config).
 * Called once at startup via warnOldEnvVars().
 */
export function warnOldEnvVars(): void {
  for (const [old, replacement] of Object.entries(OLD_ENV_VAR_MAP)) {
    if (envStr(old)) {
      process.stderr.write(
        `[scrybe] env var ${old} is set with a pre-v0.29 name and will be ignored. ` +
        `Update your shell exports / MCP server config to ${replacement}.\n`
      );
    }
  }
  if (envStr("OPENAI_API_KEY")) {
    process.stderr.write(
      `[scrybe] OPENAI_API_KEY fallback is removed. ` +
      `Set SCRYBE_CODE_EMBEDDING_API_KEY explicitly.\n`
    );
  }
}

function buildEmbeddingConfig() {
  const baseUrl = envStr("SCRYBE_CODE_EMBEDDING_BASE_URL");
  const apiKey = envStr("SCRYBE_CODE_EMBEDDING_API_KEY");
  const localModelEnv = envStr("SCRYBE_LOCAL_EMBEDDER");
  const modelEnv = envStr("SCRYBE_CODE_EMBEDDING_MODEL");
  const dimsEnv = envStr("SCRYBE_CODE_EMBEDDING_DIMENSIONS");

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
      `SCRYBE_CODE_EMBEDDING_MODEL is not set. ` +
      (modelsUrl
        ? `Fetch ${modelsUrl} to list available models, pick an embedding model, ` +
          `then set SCRYBE_CODE_EMBEDDING_MODEL and SCRYBE_CODE_EMBEDDING_DIMENSIONS in your config.`
        : `Set SCRYBE_CODE_EMBEDDING_MODEL and SCRYBE_CODE_EMBEDDING_DIMENSIONS in your config.`);
  }

  const model = modelEnv ?? provider?.model ?? "text-embedding-3-small";
  const dimensions = dimsEnv
    ? parseInt(dimsEnv, 10)
    : (provider?.dimensions ?? 1536);

  return { baseUrl, model, dimensions, configError, providerType: "api" as const };
}

function buildRerankConfig() {
  const enabled = process.env.SCRYBE_RERANK === "true";
  const apiKey = process.env.SCRYBE_RERANK_API_KEY ?? "";
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

  // Auto-detect Voyage from embedding provider — keep rerank-on-Voyage convenience,
  // but key comes from SCRYBE_RERANK_API_KEY only (no fallback to embedding key).
  const embeddingBaseUrl = envStr("SCRYBE_CODE_EMBEDDING_BASE_URL");
  const provider = resolveProvider(embeddingBaseUrl);
  if (provider?.name === "Voyage AI") {
    return {
      rerankEnabled: true,
      rerankBaseUrl: "https://api.voyageai.com/v1/rerank",
      rerankModel: process.env.SCRYBE_RERANK_MODEL ?? "rerank-2.5",
      rerankApiKey: apiKey,  // SCRYBE_RERANK_API_KEY only; no fallback to embedding key
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

function buildKnowledgeEmbeddingConfig() {
  const baseUrl =
    envStr("SCRYBE_KNOWLEDGE_EMBEDDING_BASE_URL") ??
    envStr("SCRYBE_CODE_EMBEDDING_BASE_URL") ??   // inherit from code embedding provider
    undefined;

  const provider = resolveProvider(baseUrl);

  // Inherit local provider when code embedding is also local
  const codeIsLocal = !!(envStr("SCRYBE_LOCAL_EMBEDDER") ||
    (!envStr("SCRYBE_CODE_EMBEDDING_BASE_URL") && !envStr("SCRYBE_CODE_EMBEDDING_API_KEY") &&
     !envStr("SCRYBE_CODE_EMBEDDING_MODEL")));
  const knowledgeIsLocal = codeIsLocal && !envStr("SCRYBE_KNOWLEDGE_EMBEDDING_BASE_URL");

  const model = knowledgeIsLocal
    ? (envStr("SCRYBE_KNOWLEDGE_EMBEDDING_MODEL") ?? envStr("SCRYBE_LOCAL_EMBEDDER") ?? LOCAL_PROVIDER_DEFAULTS.textModel)
    : (envStr("SCRYBE_KNOWLEDGE_EMBEDDING_MODEL") ?? provider?.textModel ?? "text-embedding-3-small");

  const dimsEnv = envStr("SCRYBE_KNOWLEDGE_EMBEDDING_DIMENSIONS");
  const dimensions = dimsEnv
    ? parseInt(dimsEnv, 10)
    : knowledgeIsLocal
      ? LOCAL_PROVIDER_DEFAULTS.dimensions
      : (provider?.dimensions ?? 1536);

  const apiKey = envStr("SCRYBE_KNOWLEDGE_EMBEDDING_API_KEY") ?? "";

  return { baseUrl: knowledgeIsLocal ? undefined : baseUrl, model, dimensions, apiKey, providerType: knowledgeIsLocal ? "local" as const : "api" as const };
}

function buildHybridConfig() {
  const enabled = process.env.SCRYBE_HYBRID !== "false";
  const rrfK = parseInt(process.env.SCRYBE_RRF_K ?? "60", 10);
  return { hybridEnabled: enabled, rrfK };
}

const embedding = buildEmbeddingConfig();
const knowledgeEmbedding = buildKnowledgeEmbeddingConfig();
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

  // Code embedding provider — local WASM or any OpenAI-compatible endpoint
  embeddingProviderType: embedding.providerType,
  embeddingApiKey: envStr("SCRYBE_CODE_EMBEDDING_API_KEY") ?? "",
  embeddingBaseUrl: embedding.baseUrl,
  embeddingModel: embedding.model,
  embeddingDimensions: embedding.dimensions,
  embeddingConfigError: embedding.configError,
  embedBatchSize: parseInt(process.env.SCRYBE_EMBED_BATCH_SIZE ?? "100", 10),
  embedBatchDelayMs: parseInt(process.env.SCRYBE_EMBED_BATCH_DELAY_MS ?? "0", 10),

  // Knowledge embedding provider — for knowledge/ticket sources
  // Falls back to code embedding config if not set separately.
  textEmbeddingProviderType: knowledgeEmbedding.providerType,
  textEmbeddingApiKey: knowledgeEmbedding.apiKey,
  textEmbeddingBaseUrl: knowledgeEmbedding.baseUrl,
  textEmbeddingModel: knowledgeEmbedding.model,
  textEmbeddingDimensions: knowledgeEmbedding.dimensions,

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
