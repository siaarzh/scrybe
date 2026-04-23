export interface ProviderDefaults {
  name: string;
  model: string;       // code embedding model
  textModel: string;   // text/knowledge embedding model
  dimensions: number;
  // Whether this provider supports reranking (Voyage AI only).
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
