import { getProvider, getModel } from "./providers.js";
import { resolveEnvRef } from "./config.js";
import type { ScrybeConfig } from "./config.js";

/** Preset slot identifiers that drive profile-based routing. */
export type PresetSlot = "code_preset" | "text_preset" | "rerank_preset";

/**
 * Fully resolved embedding configuration derived from a named preset.
 * All `${VAR}` references in `credentials` are already expanded.
 */
export interface ResolvedEmbedding {
  provider: string;
  model: string;
  dim: number;
  base_url: string;
  /** Resolved credential value (not an env-var ref). May be empty for auth:none providers. */
  credentials: string;
  profile: "code" | "text";
  /**
   * Optional asymmetric prompt templates (Plan 77 / Plan 70).
   * Only meaningful for local provider. When set, prepend `query` to query text
   * and `passage` to each passage text before embedding.
   */
  prompt_template?: { query: string; passage: string };
  /**
   * Per-preset maximum input token budget (Plan 77).
   * When set, the chunker enforces a char cap of `max_input_tokens * 4` (heuristic).
   * Unset = retain legacy 32_000-char behavior.
   */
  max_input_tokens?: number;
}

/**
 * Resolve a named preset from config into a fully-expanded `ResolvedEmbedding`.
 *
 * Rules:
 * - Catalog presets: `base_url` and `dim` come from `PROVIDERS` / `getModel`.
 * - Custom presets (`provider === "custom"`): `base_url` and `dim` are taken from
 *   the preset itself; no catalog lookup for the model.
 * - `credentials_from`: looked up one level. Chains of depth > 1 throw.
 * - Cross-profile rejection: `code_preset` slot requires a model with profile "code";
 *   `text_preset` slot requires profile "text". Custom presets are profile-agnostic.
 */
export function resolvePreset(
  presetName: string,
  slot: PresetSlot,
  cfg: ScrybeConfig,
): ResolvedEmbedding {
  if (slot === "rerank_preset") {
    throw new Error(
      `resolvePreset: rerank_preset is not an embedding preset — use resolveRerankerPreset instead`,
    );
  }

  const presets = cfg.embedding_presets;
  const preset = presets[presetName];
  if (!preset) {
    throw new Error(`embedding preset "${presetName}" not found in config`);
  }

  const { provider, model } = preset;
  const isCustom = provider === "custom";

  let dim: number;
  let base_url: string;
  let profile: "code" | "text";

  if (isCustom) {
    // Custom: raw fields come from the preset itself.
    if (preset.dim === undefined) {
      throw new Error(`custom preset "${presetName}" is missing required field "dim"`);
    }
    if (!preset.base_url) {
      throw new Error(`custom preset "${presetName}" is missing required field "base_url"`);
    }
    dim = preset.dim;
    base_url = preset.base_url;
    // Custom presets are profile-agnostic — derive from slot.
    profile = slot === "code_preset" ? "code" : "text";
  } else {
    // Catalog preset: fill in dim + base_url from the catalog.
    const providerSpec = getProvider(provider);
    const modelSpec = getModel(provider, model);

    dim = modelSpec.dim;
    base_url = providerSpec.embedding_base_url ?? "";
    profile = modelSpec.profile;

    // Cross-profile rejection: slot must match model profile.
    // The local provider is profile-agnostic (like custom) — it is the standard
    // zero-config default for both slots when no remote provider is configured.
    const requiredProfile = slot === "code_preset" ? "code" : "text";
    if (profile !== requiredProfile && provider !== "local") {
      throw new Error(
        `preset "${presetName}" uses model "${model}" with profile "${profile}", ` +
        `but it is assigned to slot "${slot}" which requires profile "${requiredProfile}"`,
      );
    }
    // For profile-agnostic providers (local), derive profile from the slot.
    if (provider === "local") {
      profile = requiredProfile;
    }
  }

  // Resolve credentials.
  let credentials = "";
  if (preset.credentials_from) {
    // One-level indirection — no chains.
    const sourcePreset = presets[preset.credentials_from];
    if (!sourcePreset) {
      throw new Error(
        `preset "${presetName}" references credentials_from "${preset.credentials_from}", ` +
        `but that preset does not exist`,
      );
    }
    if (sourcePreset.credentials_from) {
      throw new Error(
        `preset "${presetName}" references credentials_from "${preset.credentials_from}", ` +
        `which itself has credentials_from "${sourcePreset.credentials_from}". ` +
        `credentials_from chains deeper than 1 level are not supported`,
      );
    }
    if (sourcePreset.credentials) {
      credentials = resolveEnvRef(sourcePreset.credentials);
    }
  } else if (preset.credentials) {
    credentials = resolveEnvRef(preset.credentials);
  }

  return { provider, model, dim, base_url, credentials, profile, prompt_template: preset.prompt_template, max_input_tokens: preset.max_input_tokens };
}
