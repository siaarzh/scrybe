export interface ProviderDefaults {
  name: string;
  model: string;
  dimensions: number;
}

/**
 * Known OpenAI-compatible embedding providers.
 * Keyed by hostname of the base URL.
 * When EMBEDDING_BASE_URL is unset, OpenAI defaults apply.
 */
const KNOWN_PROVIDERS: Record<string, ProviderDefaults> = {
  "api.openai.com": {
    name: "OpenAI",
    model: "text-embedding-3-small",
    dimensions: 1536,
  },
  "api.voyageai.com": {
    name: "Voyage AI",
    model: "voyage-code-3",
    dimensions: 1024,
  },
  "api.mistral.ai": {
    name: "Mistral",
    model: "mistral-embed",
    dimensions: 1024,
  },
};

/**
 * Resolves provider defaults from a base URL.
 * - No URL → OpenAI defaults.
 * - Known URL → that provider's defaults.
 * - Unknown URL → null (caller must require explicit model config).
 */
export function resolveProvider(baseUrl: string | undefined): ProviderDefaults | null {
  if (!baseUrl) return KNOWN_PROVIDERS["api.openai.com"];
  try {
    const { hostname } = new URL(baseUrl);
    return KNOWN_PROVIDERS[hostname] ?? null;
  } catch {
    return null;
  }
}

export { KNOWN_PROVIDERS };
