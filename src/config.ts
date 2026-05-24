import { homedir } from "os";
import { join } from "path";
import { readFileSync, writeFileSync, existsSync, mkdirSync } from "fs";
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

/**
 * Parse a blend weight pair from an env-var string like "0.75,0.25".
 * Returns [w_retrieval, w_rerank] or throws with a descriptive error.
 * Rules: exactly 2 comma-separated floats, sum within ±0.01 of 1.0.
 */
export function parseBlendWeights(raw: string, envVarName: string): [number, number] {
  const parts = raw.split(",");
  if (parts.length !== 2) {
    throw new Error(
      `${envVarName}="${raw}" is invalid: expected exactly 2 comma-separated floats (e.g. "0.75,0.25")`
    );
  }
  const w0 = parseFloat(parts[0]!);
  const w1 = parseFloat(parts[1]!);
  if (!isFinite(w0) || !isFinite(w1)) {
    throw new Error(
      `${envVarName}="${raw}" is invalid: values must be finite numbers`
    );
  }
  const sum = w0 + w1;
  if (Math.abs(sum - 1.0) > 0.01) {
    throw new Error(
      `${envVarName}="${raw}" is invalid: weights must sum to 1.0 (±0.01), got ${sum.toFixed(4)}`
    );
  }
  return [w0, w1];
}

function buildRerankBlendConfig() {
  const top3Raw = process.env.SCRYBE_RERANK_BLEND_TOP3 ?? "0.75,0.25";
  const tailRaw = process.env.SCRYBE_RERANK_BLEND_TAIL ?? "0.40,0.60";

  let rerankBlendTop3: [number, number];
  let rerankBlendTail: [number, number];

  try {
    rerankBlendTop3 = parseBlendWeights(top3Raw, "SCRYBE_RERANK_BLEND_TOP3");
  } catch (e) {
    console.error(`[scrybe] ${e instanceof Error ? e.message : String(e)}. Using default "0.75,0.25".`);
    rerankBlendTop3 = [0.75, 0.25];
  }

  try {
    rerankBlendTail = parseBlendWeights(tailRaw, "SCRYBE_RERANK_BLEND_TAIL");
  } catch (e) {
    console.error(`[scrybe] ${e instanceof Error ? e.message : String(e)}. Using default "0.40,0.60".`);
    rerankBlendTail = [0.40, 0.60];
  }

  return { rerankBlendTop3, rerankBlendTail };
}

function buildRerankConfig() {
  const enabled = process.env.SCRYBE_RERANK === "true";
  const apiKey = process.env.SCRYBE_RERANK_API_KEY ?? "";
  const fetchMultiplier = parseInt(
    process.env.SCRYBE_RERANK_FETCH_MULTIPLIER ?? "5",
    10
  );
  const blend = buildRerankBlendConfig();

  if (!enabled) {
    return { rerankEnabled: false, rerankBaseUrl: "", rerankModel: "", rerankApiKey: apiKey, rerankFetchMultiplier: fetchMultiplier, rerankProviderType: "http" as const, ...blend };
  }

  // Local cross-encoder: SCRYBE_RERANK_PROVIDER=local (Plan 77 Slice 5)
  const rerankProviderEnv = process.env.SCRYBE_RERANK_PROVIDER;
  if (rerankProviderEnv === "local") {
    const model = process.env.SCRYBE_RERANK_MODEL ?? "Xenova/ms-marco-MiniLM-L-6-v2";
    return {
      rerankEnabled: true,
      rerankBaseUrl: "",
      rerankModel: model,
      rerankApiKey: apiKey,
      rerankFetchMultiplier: fetchMultiplier,
      rerankProviderType: "local" as const,
      ...blend,
    };
  }

  // Explicit custom HTTP provider
  const explicitUrl = process.env.SCRYBE_RERANK_BASE_URL;
  if (explicitUrl) {
    const model = process.env.SCRYBE_RERANK_MODEL ?? "";
    if (!model) {
      console.error("[scrybe] SCRYBE_RERANK_BASE_URL is set but SCRYBE_RERANK_MODEL is missing. Reranking disabled.");
      return { rerankEnabled: false, rerankBaseUrl: "", rerankModel: "", rerankApiKey: apiKey, rerankFetchMultiplier: fetchMultiplier, rerankProviderType: "http" as const, ...blend };
    }
    return { rerankEnabled: true, rerankBaseUrl: explicitUrl, rerankModel: model, rerankApiKey: apiKey, rerankFetchMultiplier: fetchMultiplier, rerankProviderType: "http" as const, ...blend };
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
      rerankProviderType: "http" as const,
      ...blend,
    };
  }

  console.error(
    "[scrybe] SCRYBE_RERANK=true is set but your embedding provider does not support auto-configured reranking. " +
    "Options: set SCRYBE_RERANK_PROVIDER=local for in-process cross-encoder (no API key needed), " +
    "switch to Voyage AI for auto-configured HTTP reranking, or " +
    "set SCRYBE_RERANK_BASE_URL + SCRYBE_RERANK_MODEL for a custom HTTP reranker. " +
    "Reranking is DISABLED."
  );
  return { rerankEnabled: false, rerankBaseUrl: "", rerankModel: "", rerankApiKey: apiKey, rerankFetchMultiplier: fetchMultiplier, rerankProviderType: "http" as const, ...blend };
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

// ─── config.json (Plan 23) ────────────────────────────────────────────────────

/**
 * Resolves `${VAR}` references in a string against process.env.
 * - Strings with no `${...}` tokens are returned verbatim.
 * - A missing env var throws with a message that names the variable.
 */
export function resolveEnvRef(value: string): string {
  return value.replace(/\$\{([A-Z_][A-Z0-9_]*)\}/g, (_, name: string) => {
    const v = process.env[name];
    if (v === undefined) {
      throw new Error(`env var ${name} not set (referenced in scrybe config)`);
    }
    return v;
  });
}

export interface EmbeddingPreset {
  provider: string;
  model: string;
  credentials?: string;
  /** Reuse credentials from another named embedding preset (avoids duplicate paste). One level only. */
  credentials_from?: string;
  /** Custom-provider only: raw API base URL (not in catalog). */
  base_url?: string;
  /** Custom-provider only: embedding dimensions (not in catalog). */
  dim?: number;
  /**
   * Per-preset asymmetric prompt templates (Plan 77 / Plan 70).
   * When set, the query string is prepended with `query` before embedding,
   * and each passage is prepended with `passage` before embedding.
   * Required for e5-family models (e.g. multilingual-e5-small) which are
   * trained with asymmetric query/passage geometry.
   * Example: { query: "query: ", passage: "passage: " }
   */
  prompt_template?: { query: string; passage: string };
  /**
   * Per-preset maximum input token budget (Plan 77).
   * When set, the chunker enforces a char cap of `max_input_tokens * 4` (heuristic)
   * so no single chunk silently truncates at the ONNX/API boundary.
   * The embedder also applies this cap as a final safety net.
   * Default for local e5-small: 512. Unset = retain legacy 32_000-char behavior.
   */
  max_input_tokens?: number;
}

export interface RerankerPreset {
  /**
   * Reranker backend (Plan 77 Slice 5).
   * - "http": HTTP endpoint (OpenAI-compatible rerank API). Requires baseUrl (via env or config).
   * - "local": In-process cross-encoder via @xenova/transformers. No API key required.
   * Default: "http" (backward-compatible with existing Voyage AI / custom HTTP setups).
   */
  provider?: "local" | "http";
  model: string;
  /** Reuse credentials from a named embedding preset (avoids duplicate paste). */
  credentials_from?: string;
  credentials?: string;
}

export interface ScrybeConfigAssignments {
  code_preset: string;
  text_preset: string;
  rerank_preset?: string;
}

export interface ScrybeConfig {
  schema_version: number;
  embedding_presets: Record<string, EmbeddingPreset>;
  reranker_presets?: Record<string, RerankerPreset>;
  assignments: ScrybeConfigAssignments;
}

/** Validates a parsed object as a ScrybeConfig. Returns an error string or null. */
function validateScrybeConfig(obj: unknown): string | null {
  if (typeof obj !== "object" || obj === null) return "config.json is not a JSON object";
  const c = obj as Record<string, unknown>;
  if (typeof c["schema_version"] !== "number") return "config.json: missing or non-numeric schema_version";
  if (typeof c["embedding_presets"] !== "object" || c["embedding_presets"] === null) {
    return "config.json: missing embedding_presets";
  }
  for (const [name, preset] of Object.entries(c["embedding_presets"] as Record<string, unknown>)) {
    if (typeof preset !== "object" || preset === null) return `config.json: embedding_presets.${name} is not an object`;
    const p = preset as Record<string, unknown>;
    if (typeof p["provider"] !== "string") return `config.json: embedding_presets.${name}.provider missing`;
    if (typeof p["model"] !== "string") return `config.json: embedding_presets.${name}.model missing`;
    if (p["prompt_template"] !== undefined) {
      const pt = p["prompt_template"];
      if (typeof pt !== "object" || pt === null) {
        return `config.json: embedding_presets.${name}.prompt_template must be an object`;
      }
      const ptObj = pt as Record<string, unknown>;
      if (typeof ptObj["query"] !== "string") {
        return `config.json: embedding_presets.${name}.prompt_template.query must be a string`;
      }
      if (typeof ptObj["passage"] !== "string") {
        return `config.json: embedding_presets.${name}.prompt_template.passage must be a string`;
      }
    }
    if (p["max_input_tokens"] !== undefined && typeof p["max_input_tokens"] !== "number") {
      return `config.json: embedding_presets.${name}.max_input_tokens must be a number`;
    }
  }
  if (typeof c["assignments"] !== "object" || c["assignments"] === null) {
    return "config.json: missing assignments";
  }
  const a = c["assignments"] as Record<string, unknown>;
  if (typeof a["code_preset"] !== "string") return "config.json: assignments.code_preset missing";
  if (typeof a["text_preset"] !== "string") return "config.json: assignments.text_preset missing";
  return null;
}

/**
 * Reads `<DATA_DIR>/config.json`.
 * Returns null if the file does not exist.
 * Throws with a descriptive message on parse or schema errors.
 *
 * Path is computed dynamically (respects SCRYBE_DATA_DIR changes during testing).
 */
export function readScrybeConfig(): ScrybeConfig | null {
  const p = join(getDataDir(), "config.json");
  if (!existsSync(p)) return null;
  let raw: string;
  try {
    raw = readFileSync(p, "utf8");
  } catch (err) {
    throw new Error(`Failed to read config.json: ${err instanceof Error ? err.message : String(err)}`);
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (err) {
    throw new Error(`config.json is not valid JSON: ${err instanceof Error ? err.message : String(err)}`);
  }
  const validationError = validateScrybeConfig(parsed);
  if (validationError) throw new Error(validationError);
  return parsed as ScrybeConfig;
}

/** Writes a ScrybeConfig to `<DATA_DIR>/config.json`. */
export function writeScrybeConfig(cfg: ScrybeConfig): void {
  const dir = getDataDir();
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, "config.json"), JSON.stringify(cfg, null, 2) + "\n", "utf8");
}
