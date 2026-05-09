/**
 * MCP tools for embedding preset management.
 * Two tools: add_embedding_preset and assign_preset.
 */
import { listProjects } from "../registry.js";
import { readTableMeta } from "../vector-store.js";
import { readScrybeConfig } from "../config.js";
import { resolvePreset } from "../preset-resolver.js";
import { runPresetAdd, runAssign } from "./model.js";
import type { Tool } from "./types.js";

// ─── add_embedding_preset ─────────────────────────────────────────────────────

export interface AddEmbeddingPresetInput {
  name: string;
  provider: string;
  model: string;
  credentials?: string;
  credentials_from?: string;
  base_url?: string;
  dim?: number;
}

export interface AddEmbeddingPresetOutput {
  ok: boolean;
  preset_name: string;
  error?: string;
}

export const addEmbeddingPresetTool: Tool<
  AddEmbeddingPresetInput,
  AddEmbeddingPresetOutput
> = {
  spec: {
    name: "add_embedding_preset",
    description:
      "Add a new embedding preset to the configuration. Presets are named references to embedding models with provider, model, and optional credentials. " +
      "Catalog providers (voyage, openai, local) derive base_url and dimensions from the catalog. " +
      "Custom provider requires explicit base_url and dim. Returns ok:true and the preset name on success.",
    inputSchema: {
      type: "object",
      properties: {
        name: { type: "string", description: "Unique preset name" },
        provider: { type: "string", description: "Provider key: voyage, openai, local, or custom" },
        model: { type: "string", description: "Model name from the provider catalog (or custom model for custom provider)" },
        credentials: { type: "string", description: "Literal credential value or ${VAR} reference to environment variable" },
        credentials_from: { type: "string", description: "Reuse credentials from another preset (for rerank presets)" },
        base_url: { type: "string", description: "API base URL (required for custom provider only)" },
        dim: { type: "number", description: "Embedding dimensions (required for custom provider only)" },
      },
      required: ["name", "provider", "model"],
    },
    annotations: { idempotentHint: false, openWorldHint: false },
  },
  handler: async ({
    name,
    provider,
    model,
    credentials,
    credentials_from: credentialsFrom,
    base_url: baseUrl,
    dim,
  }) => {
    try {
      runPresetAdd({
        name,
        provider,
        model,
        credentials,
        credentialsFrom,
        baseUrl,
        dim,
      });
      return { ok: true, preset_name: name };
    } catch (err: any) {
      return { ok: false, preset_name: name, error: err.message };
    }
  },
};

// ─── assign_preset ────────────────────────────────────────────────────────────

export interface AssignPresetInput {
  slot: "code" | "text" | "rerank";
  preset_name: string;
}

export interface AssignPresetOutput {
  ok: boolean;
  requires_reindex: boolean;
  error?: string;
}

/**
 * Compare embedding triples: (model, dim, provider).
 * Used to determine if a preset switch requires reindexing.
 */
interface EmbeddingTriple {
  model: string;
  dim: number;
  provider: string;
}

function getTripleFromStamp(stamp: Record<string, unknown> | null): EmbeddingTriple | null {
  if (!stamp) return null;
  const model = stamp.model as string | undefined;
  const dim = stamp.dim as number | undefined;
  const provider = stamp.provider as string | undefined;
  if (!model || dim === undefined || !provider) return null;
  return { model, dim, provider };
}

function triples_equal(a: EmbeddingTriple | null, b: EmbeddingTriple | null): boolean {
  if (!a || !b) return false;
  return a.model === b.model && a.dim === b.dim && a.provider === b.provider;
}

export const assignPresetTool: Tool<
  AssignPresetInput,
  AssignPresetOutput
> = {
  spec: {
    name: "assign_preset",
    description:
      "Assign an embedding preset to a slot (code, text, or rerank). " +
      "Returns requires_reindex: true when the new preset differs in (model, dim, provider) from the previous assignment; " +
      "returns false for preset renames that preserve the embedding triple. " +
      "Slot 'rerank' accepts 'none' as preset_name to clear the assignment.",
    inputSchema: {
      type: "object",
      properties: {
        slot: { type: "string", enum: ["code", "text", "rerank"], description: "Preset slot to assign to" },
        preset_name: { type: "string", description: "Preset name to assign (or 'none' for rerank)" },
      },
      required: ["slot", "preset_name"],
    },
    annotations: { idempotentHint: false, openWorldHint: false },
  },
  handler: async ({ slot, preset_name: presetName }) => {
    try {
      const cfg = readScrybeConfig();
      if (!cfg) {
        return {
          ok: false,
          requires_reindex: false,
          error: "No config.json found. Run 'scrybe model preset add' first.",
        };
      }

      // Map CLI slot names to config keys
      const slotMap: Record<"code" | "text" | "rerank", "code_preset" | "text_preset" | "rerank_preset"> = {
        code: "code_preset",
        text: "text_preset",
        rerank: "rerank_preset",
      };
      const cfgSlot = slotMap[slot];

      // Determine if reindex is needed
      let requires_reindex = false;

      if (slot === "rerank") {
        // Rerank slot: "none" to clear, any other name must exist
        if (presetName !== "none") {
          const rPresets = cfg.reranker_presets ?? {};
          if (!(presetName in rPresets)) {
            return {
              ok: false,
              requires_reindex: false,
              error: `Reranker preset '${presetName}' not found in reranker_presets.`,
            };
          }
        }
        // Rerank doesn't affect reindex requirement
        requires_reindex = false;
      } else {
        // Code or text slot: verify preset exists and profile matches
        if (!(presetName in cfg.embedding_presets)) {
          return {
            ok: false,
            requires_reindex: false,
            error: `Preset '${presetName}' not found in embedding_presets.`,
          };
        }

        // Cross-profile validation via resolvePreset
        try {
          resolvePreset(presetName, cfgSlot, cfg);
        } catch (err: any) {
          return {
            ok: false,
            requires_reindex: false,
            error: err.message,
          };
        }

        // Compute requires_reindex: compare previous and new preset triples
        const currentPresetName = cfg.assignments[cfgSlot];
        const currentPreset = currentPresetName
          ? cfg.embedding_presets[currentPresetName]
          : null;
        const newPreset = cfg.embedding_presets[presetName];

        // Get current triple from config (may be a catalog preset, custom, etc.)
        let currentTriple: EmbeddingTriple | null = null;
        if (currentPreset && currentPreset.provider !== "custom") {
          // Catalog preset: resolve to get dim
          try {
            const resolved = resolvePreset(currentPresetName!, cfgSlot, cfg);
            currentTriple = {
              model: resolved.model,
              dim: resolved.dim,
              provider: resolved.provider,
            };
          } catch {
            // Ignore resolution errors; treat as null for comparison
          }
        } else if (currentPreset && currentPreset.provider === "custom") {
          // Custom preset: use explicit fields
          if (currentPreset.dim !== undefined && currentPreset.base_url) {
            currentTriple = {
              model: currentPreset.model,
              dim: currentPreset.dim,
              provider: currentPreset.provider,
            };
          }
        }

        // Get new triple from config
        let newTriple: EmbeddingTriple | null = null;
        if (newPreset.provider !== "custom") {
          try {
            const resolved = resolvePreset(presetName, cfgSlot, cfg);
            newTriple = {
              model: resolved.model,
              dim: resolved.dim,
              provider: resolved.provider,
            };
          } catch {
            // Resolution error shouldn't happen here since we validated above
          }
        } else if (newPreset.dim !== undefined && newPreset.base_url) {
          newTriple = {
            model: newPreset.model,
            dim: newPreset.dim,
            provider: newPreset.provider,
          };
        }

        // Check if triples differ across any affected source
        // For code sources, check if the stamped triple differs from the new triple
        // Only set requires_reindex if there's an existing index with a different triple
        const projects = listProjects();
        for (const project of projects) {
          for (const source of project.sources) {
            // Only code sources use code preset, text sources use text preset
            const sourceProfile =
              source.source_config.type === "code" ? "code" : "text";
            if ((slot === "code" && sourceProfile !== "code") ||
                (slot === "text" && sourceProfile !== "text")) {
              continue;
            }

            if (!source.table_name) continue;

            // Read the source's stamped triple from table metadata
            const tableMeta = readTableMeta(source.table_name);
            const stampedTriple = getTripleFromStamp(tableMeta);

            // Require reindex only if:
            // 1. There's an existing stamp with a different triple, OR
            // 2. The current config assignment differs from the new triple
            // But NOT if this is a first-time assignment (no current triple and no stamped triple)
            if (stampedTriple && !triples_equal(stampedTriple, newTriple)) {
              requires_reindex = true;
              break;
            }
            if (currentTriple && !triples_equal(currentTriple, newTriple)) {
              requires_reindex = true;
              break;
            }
          }
          if (requires_reindex) break;
        }
      }

      // Apply the assignment
      try {
        runAssign({
          code: slot === "code" ? presetName : undefined,
          text: slot === "text" ? presetName : undefined,
          rerank: slot === "rerank" ? presetName : undefined,
        });
      } catch (err: any) {
        return {
          ok: false,
          requires_reindex: false,
          error: err.message,
        };
      }

      return {
        ok: true,
        requires_reindex,
      };
    } catch (err: any) {
      return {
        ok: false,
        requires_reindex: false,
        error: err.message,
      };
    }
  },
};
