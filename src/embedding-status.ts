import { config, readScrybeConfig } from "./config.js";
import { resolvePreset } from "./preset-resolver.js";

/**
 * Lightweight configured-embedding snapshot for MCP status surfaces.
 *
 * A config.json assignment is authoritative when present. The legacy
 * environment-derived config is only a compatibility fallback for pre-preset
 * installations; reporting it for a configured installation is misleading.
 */
export interface EmbeddingStatusSnapshot {
  config_present: boolean;
  code_provider_type: string;
  code_model: string;
  text_provider_type: string;
  text_model: string;
  api_key_present: boolean;
  config_error: boolean;
  config_error_message: string | null;
}

function providerType(provider: string): "local" | "api" {
  return provider === "local" ? "local" : "api";
}

export function configuredEmbeddingStatus(): EmbeddingStatusSnapshot {
  let scrybeConfig;
  try {
    scrybeConfig = readScrybeConfig();
  } catch (err: any) {
    const message = err instanceof Error ? err.message : String(err);
    return {
      config_present: false,
      code_provider_type: "",
      code_model: "",
      text_provider_type: "",
      text_model: "",
      api_key_present: false,
      config_error: true,
      config_error_message: message,
    };
  }
  if (scrybeConfig !== null) {
    try {
      const code = resolvePreset(scrybeConfig.assignments.code_preset, "code_preset", scrybeConfig);
      const text = resolvePreset(scrybeConfig.assignments.text_preset, "text_preset", scrybeConfig);
      return {
        config_present: true,
        code_provider_type: providerType(code.provider),
        code_model: code.model,
        text_provider_type: providerType(text.provider),
        text_model: text.model,
        // This means the selected code preset's credential reference resolved.
        // A local OpenAI-compatible server may deliberately use a non-secret
        // sentinel value such as "not-needed".
        api_key_present: code.provider === "local" || code.credentials.length > 0,
        config_error: false,
        config_error_message: null,
      };
    } catch (err: any) {
      const message = err instanceof Error ? err.message : String(err);
      return {
        config_present: true,
        code_provider_type: "",
        code_model: "",
        text_provider_type: "",
        text_model: "",
        api_key_present: false,
        config_error: true,
        config_error_message: message,
      };
    }
  }

  return {
    config_present: false,
    code_provider_type: config.embeddingProviderType,
    code_model: config.embeddingModel,
    text_provider_type: config.textEmbeddingProviderType,
    text_model: config.textEmbeddingModel,
    api_key_present: !!config.embeddingApiKey,
    config_error: !!config.embeddingConfigError,
    config_error_message: config.embeddingConfigError ?? null,
  };
}
