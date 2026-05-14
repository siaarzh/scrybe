// ─── Legacy interface (kept for backward compat with config.ts / registry.ts) ──

export interface ProviderDefaults {
  name: string;
  model: string;       // code embedding model
  textModel: string;   // text/knowledge embedding model
  dimensions: number;
  supports_rerank?: boolean;
}

/**
 * Known OpenAI-compatible embedding providers.
 * Keyed by hostname of the base URL.
 */
const KNOWN_PROVIDERS: Record<string, ProviderDefaults> = {
  "api.openai.com": {
    name: "OpenAI",
    model: "text-embedding-3-small",
    textModel: "text-embedding-3-small",
    dimensions: 1536,
  },
  "api.voyageai.com": {
    name: "Voyage AI",
    model: "voyage-code-3",
    textModel: "voyage-4",
    dimensions: 1024,
    supports_rerank: true,
  },
  "api.mistral.ai": {
    name: "Mistral",
    model: "mistral-embed",
    textModel: "mistral-embed",
    dimensions: 1024,
  },
};

/** Defaults for the local WASM/ONNX provider (no API key, no network). */
export const LOCAL_PROVIDER_DEFAULTS: ProviderDefaults = {
  name: "Local (offline)",
  // Chosen by M-D5 Phase 1 benchmark: 100% P@5 and 100% cross-lingual hit rate
  model: "Xenova/multilingual-e5-small",
  textModel: "Xenova/multilingual-e5-small",
  dimensions: 384,
  supports_rerank: false,
};

/**
 * Resolves provider defaults from a base URL.
 * - No URL → null (caller checks whether local or OpenAI applies).
 * - Known URL → that provider's defaults.
 * - Unknown URL → null (caller must require explicit model config).
 */
export function resolveProvider(baseUrl: string | undefined): ProviderDefaults | null {
  if (!baseUrl) return null;
  try {
    const { hostname } = new URL(baseUrl);
    return KNOWN_PROVIDERS[hostname] ?? null;
  } catch {
    return null;
  }
}

export { KNOWN_PROVIDERS };

// ─── Catalog (Plan 23) ────────────────────────────────────────────────────────

export interface EmbeddingModelSpec {
  dim: number;
  profile: "code" | "text";
  configurable_dim?: boolean;
}

export interface RerankModelSpec {
  // extensible — no required fields yet
}

export interface ProviderSpec {
  name: string;
  embedding_base_url?: string;
  rerank_base_url?: string;
  auth: "bearer" | "none";
  embedding_models: Record<string, EmbeddingModelSpec>;
  rerank_models: Record<string, RerankModelSpec> | null;
  models_endpoint?: string;
  /** Custom provider accepts raw fields (base_url, dim) not present in catalog. */
  accepts_raw_fields?: boolean;
}

export const PROVIDERS: Record<string, ProviderSpec> = {
  voyage: {
    name: "Voyage AI",
    embedding_base_url: "https://api.voyageai.com/v1",
    rerank_base_url: "https://api.voyageai.com/v1/rerank",
    auth: "bearer",
    embedding_models: {
      "voyage-code-3":  { dim: 1024, profile: "code" },
      "voyage-3":       { dim: 1024, profile: "text" },
      "voyage-3-large": { dim: 1024, profile: "text" },
      "voyage-3.5":      { dim: 1024, profile: "text", configurable_dim: true },
      "voyage-3.5-lite": { dim: 1024, profile: "text", configurable_dim: true },
      "voyage-4":        { dim: 1024, profile: "text", configurable_dim: true },
      "voyage-4-lite":   { dim: 1024, profile: "text", configurable_dim: true },
      "voyage-4-large":  { dim: 1024, profile: "text", configurable_dim: true },
    },
    rerank_models: { "rerank-2.5": {}, "rerank-2": {} },
    models_endpoint: "/v1/models",
  },
  openai: {
    name: "OpenAI",
    embedding_base_url: "https://api.openai.com/v1",
    auth: "bearer",
    embedding_models: {
      "text-embedding-3-small": { dim: 1536, profile: "text", configurable_dim: true },
      "text-embedding-3-large": { dim: 3072, profile: "text", configurable_dim: true },
    },
    rerank_models: null,
  },
  local: {
    name: "Local (in-process)",
    auth: "none",
    embedding_models: {
      "Xenova/multilingual-e5-small": { dim: 384, profile: "text" },
      "Xenova/all-MiniLM-L6-v2":      { dim: 384, profile: "text" },
    },
    rerank_models: null,
  },
  custom: {
    name: "Custom (OpenAI-compatible)",
    auth: "bearer",
    embedding_models: {},
    rerank_models: null,
    accepts_raw_fields: true,
  },
};

/** Returns the provider spec or throws for unknown providers. */
export function getProvider(providerKey: string): ProviderSpec {
  const spec = PROVIDERS[providerKey];
  if (!spec) throw new Error(`unknown provider: "${providerKey}"`);
  return spec;
}

/** Returns the embedding model entry or throws if not found in the catalog. */
export function getModel(providerKey: string, modelName: string): EmbeddingModelSpec {
  const spec = getProvider(providerKey);
  const model = spec.embedding_models[modelName];
  if (!model) throw new Error(`model "${modelName}" not found in provider "${providerKey}"`);
  return model;
}
