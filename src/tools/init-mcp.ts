/**
 * MCP tool: init
 *
 * Surfaces the existing CLI wizard's verify+index flow over MCP.
 * Accepts provider/model selections as structured input, writes config via
 * synthesizeWizardConfig + writeEnvFile, then enqueues an initial reindex job
 * via the same daemon submit path that add_source uses.
 *
 * Validation is per-provider: API providers are verified synchronously
 * (cheap network round-trip → typed validation_failed). Local providers are
 * NOT validated synchronously — the model download + load is deferred into the
 * reindex job, which reports progress via the downloading-model phase and
 * surfaces a friendly classified error on failure. This keeps init from
 * blocking on a multi-MB model download.
 *
 * Out of scope: model switching (that's a separate future tool). This tool
 * is first-run init only.
 */

import { readScrybeConfig, writeScrybeConfig, config } from "../config.js";
import {
  synthesizeWizardConfig,
  writeEnvFile,
  readEnvKeys,
  type WizardInput,
  type ProviderSelection,
} from "../onboarding/wizard.js";
import {
  validateProvider,
  type ValidateResult,
} from "../onboarding/validate-provider.js";
import { PROVIDERS } from "../providers.js";
import { ensureRunning, DaemonClient } from "../daemon/client.js";
import { submitSourceJob } from "../jobs.js";
import { listProjects } from "../registry.js";
import type { Tool } from "./types.js";

// ─── Input / Output types ─────────────────────────────────────────────────────

export interface InitInput {
  /** Provider for code sources: "local" | "voyage" | "openai" | "custom" */
  code_provider: string;
  /** Model name for code sources. Required for non-local providers. */
  code_model?: string;
  /** API key for code provider. Required for non-local providers. */
  code_api_key?: string;
  /** Base URL for custom provider (required when code_provider = "custom"). */
  code_base_url?: string;
  /** Embedding dimensions (required when code_provider = "custom"). */
  code_dim?: number;

  /**
   * Provider for text/knowledge sources.
   * Defaults to same as code_provider when omitted.
   */
  text_provider?: string;
  /** Model name for text sources. Defaults to provider's text model. */
  text_model?: string;
  /** API key for text provider. Defaults to code_api_key when same provider. */
  text_api_key?: string;
  /** Base URL for custom text provider. */
  text_base_url?: string;
  /** Embedding dimensions for custom text provider. */
  text_dim?: number;

  /** Reranker provider (optional). Must match an embedding provider above. */
  rerank_provider?: string;
  /** Reranker model (required when rerank_provider is set). */
  rerank_model?: string;

  /**
   * When true, overwrite existing config even if already configured.
   * Default: false (returns "already configured" message without overwriting).
   */
  reconfigure?: boolean;
}

export interface InitOutput {
  ok: boolean;
  /** Present on success or when already configured. */
  status?: "configured" | "already_configured" | "validation_failed";
  /** Returned when a reindex job was enqueued. Poll with reindex_status. */
  job_id?: string;
  /** Registered project IDs that were enqueued for initial indexing. */
  indexed_projects?: string[];
  /** Validation result details (when status = validation_failed). */
  validation?: ValidateResult;
  /** Human-readable message. */
  message?: string;
  error?: string;
}

// ─── Helper: resolve effective provider selection ─────────────────────────────

function resolveCodeSelection(input: InitInput): ProviderSelection {
  const provider = input.code_provider;

  if (provider === "local") {
    const provSpec = PROVIDERS["local"];
    const defaultModel = Object.keys(provSpec?.embedding_models ?? {})[0]
      ?? "Xenova/multilingual-e5-small";
    return {
      provider: "local",
      apiKey: "",
      model: input.code_model ?? defaultModel,
    };
  }

  if (provider === "custom") {
    if (!input.code_base_url) throw new Error("code_base_url is required when code_provider is 'custom'");
    if (!input.code_dim) throw new Error("code_dim is required when code_provider is 'custom'");
    if (!input.code_model) throw new Error("code_model is required when code_provider is 'custom'");
    return {
      provider: "custom",
      apiKey: input.code_api_key ?? "",
      model: input.code_model,
      baseUrl: input.code_base_url,
      dim: input.code_dim,
    };
  }

  // Catalog provider (voyage, openai, etc.)
  const provSpec = PROVIDERS[provider];
  if (!provSpec) throw new Error(`Unknown provider: "${provider}". Known providers: ${Object.keys(PROVIDERS).join(", ")}`);
  if (!input.code_api_key) throw new Error(`code_api_key is required for provider "${provider}"`);

  const codeModels = Object.entries(provSpec.embedding_models)
    .filter(([, ms]) => ms.profile === "code");
  const defaultModel = codeModels.length > 0
    ? codeModels[0]![0]
    : Object.keys(provSpec.embedding_models)[0] ?? "";

  return {
    provider,
    apiKey: input.code_api_key,
    model: input.code_model ?? defaultModel,
  };
}

function resolveTextSelection(input: InitInput, codeSel: ProviderSelection): ProviderSelection {
  const textProvider = input.text_provider ?? codeSel.provider;

  if (textProvider === "local") {
    const provSpec = PROVIDERS["local"];
    const defaultModel = Object.keys(provSpec?.embedding_models ?? {})[0]
      ?? "Xenova/multilingual-e5-small";
    return {
      provider: "local",
      apiKey: "",
      model: input.text_model ?? defaultModel,
    };
  }

  if (textProvider === "custom") {
    if (!input.text_base_url) throw new Error("text_base_url is required when text_provider is 'custom'");
    if (!input.text_dim) throw new Error("text_dim is required when text_provider is 'custom'");
    if (!input.text_model) throw new Error("text_model is required when text_provider is 'custom'");
    return {
      provider: "custom",
      apiKey: input.text_api_key ?? "",
      model: input.text_model,
      baseUrl: input.text_base_url,
      dim: input.text_dim,
    };
  }

  // Same catalog provider as code? Reuse key.
  const isSameProvider = textProvider === codeSel.provider && textProvider !== "custom";
  const apiKey = isSameProvider
    ? (input.text_api_key ?? codeSel.apiKey)
    : (input.text_api_key ?? "");

  if (!isSameProvider && !apiKey) {
    throw new Error(`text_api_key is required when text_provider ("${textProvider}") differs from code_provider`);
  }

  const provSpec = PROVIDERS[textProvider];
  if (!provSpec) throw new Error(`Unknown text_provider: "${textProvider}"`);

  const textModels = Object.entries(provSpec.embedding_models)
    .filter(([, ms]) => ms.profile === "text");
  const defaultModel = textModels.length > 0
    ? textModels[0]![0]
    : Object.keys(provSpec.embedding_models)[0] ?? "";

  return {
    provider: textProvider,
    apiKey,
    model: input.text_model ?? defaultModel,
  };
}

// ─── Validate provider selections ─────────────────────────────────────────────

/**
 * Synchronously validates an API-typed provider selection (key validity + dimension probe).
 * Returns null for local-typed providers — those are deferred to the index job, which
 * emits downloading-model progress via reindex_status instead of blocking init.
 */
async function verifyIfApi(sel: ProviderSelection): Promise<ValidateResult | null> {
  if (sel.provider === "local") {
    return null; // deferred — local model load happens inside the index job
  }
  const provSpec = PROVIDERS[sel.provider];
  const baseUrl = sel.provider === "custom"
    ? (sel.baseUrl ?? "")
    : (provSpec?.embedding_base_url ?? "");
  return validateProvider({ baseUrl, model: sel.model, apiKey: sel.apiKey });
}

// ─── Tool definition ───────────────────────────────────────────────────────────

export const initTool: Tool<InitInput, InitOutput> = {
  spec: {
    name: "init",
    description:
      "Configure scrybe embedding providers and enqueue an initial index of all registered projects. " +
      "Writes config.json and .env, then submits a reindex job for every registered project and returns a job_id to poll with reindex_status. " +
      "API providers (voyage, openai, custom) are verified synchronously (key validity + dimension probe) — a bad key returns status 'validation_failed' immediately. " +
      "The local provider is NOT verified synchronously: its model download and load are deferred into the reindex job (so init returns promptly instead of blocking on a multi-MB download). Poll reindex_status — a cold local model first reports a 'downloading-model' phase, and a load failure surfaces a friendly error on the job. " +
      "If scrybe is already configured, returns status 'already_configured' without overwriting unless reconfigure:true is passed. " +
      "Supported providers: local (default, no key needed), voyage, openai, custom (OpenAI-compatible endpoint).",
    inputSchema: {
      type: "object",
      properties: {
        code_provider: {
          type: "string",
          enum: ["local", "voyage", "openai", "custom"],
          description: "Embedding provider for code sources. Default: 'local' (offline, no API key required)",
        },
        code_model: {
          type: "string",
          description: "Model name for code sources. Defaults to provider default when omitted.",
        },
        code_api_key: {
          type: "string",
          description: "API key for code provider. Required for voyage, openai, or custom.",
        },
        code_base_url: {
          type: "string",
          description: "API base URL (required when code_provider = 'custom')",
        },
        code_dim: {
          type: "number",
          description: "Embedding dimensions (required when code_provider = 'custom')",
        },
        text_provider: {
          type: "string",
          enum: ["local", "voyage", "openai", "custom"],
          description: "Provider for text/knowledge sources. Defaults to same as code_provider.",
        },
        text_model: {
          type: "string",
          description: "Model for text/knowledge sources. Defaults to provider text model.",
        },
        text_api_key: {
          type: "string",
          description: "API key for text provider (only needed if text_provider differs from code_provider).",
        },
        text_base_url: {
          type: "string",
          description: "Base URL for custom text provider.",
        },
        text_dim: {
          type: "number",
          description: "Dimensions for custom text provider.",
        },
        rerank_provider: {
          type: "string",
          description: "Reranker provider. Must match one of the embedding providers above.",
        },
        rerank_model: {
          type: "string",
          description: "Reranker model name (required when rerank_provider is set).",
        },
        reconfigure: {
          type: "boolean" as any,
          description: "When true, overwrite existing config even if already configured. Default: false.",
        },
      },
      required: ["code_provider"],
    },
    annotations: { idempotentHint: false, openWorldHint: false },
  },

  handler: async (input) => {
    try {
      // ── Already-configured guard ───────────────────────────────────────────
      const existing = readScrybeConfig();
      if (existing && !input.reconfigure) {
        const presetNames = Object.keys(existing.embedding_presets).join(", ");
        return {
          ok: true,
          status: "already_configured",
          message:
            `Scrybe is already configured (presets: ${presetNames}). ` +
            "Pass reconfigure:true to overwrite the existing configuration.",
        };
      }

      // ── Resolve provider selections ────────────────────────────────────────
      const codeSel = resolveCodeSelection(input);
      const textSel = resolveTextSelection(input, codeSel);

      const rerankSel: WizardInput["rerank"] = input.rerank_provider && input.rerank_model
        ? { provider: input.rerank_provider, model: input.rerank_model }
        : undefined;

      // ── Validate API providers synchronously; skip local ones (deferred to index job) ─
      // Local providers: model download happens inside the index job, surfaced via
      // reindex_status (downloading-model phase + percent). Blocking init on the
      // download defeats Plan 82's progress-visibility goal.
      const codeValidation = await verifyIfApi(codeSel);
      if (codeValidation !== null && !codeValidation.ok) {
        return {
          ok: false,
          status: "validation_failed",
          validation: codeValidation,
          message: `Code provider validation failed: ${codeValidation.message ?? codeValidation.errorType}`,
        };
      }

      // Only validate text provider separately if it differs from code provider
      // and is not local (local text provider is also deferred).
      const textProviderDiffers = textSel.provider !== codeSel.provider ||
        (textSel.provider === "custom" && textSel.baseUrl !== codeSel.baseUrl);
      if (textProviderDiffers) {
        const textValidation = await verifyIfApi(textSel);
        if (textValidation !== null && !textValidation.ok) {
          return {
            ok: false,
            status: "validation_failed",
            validation: textValidation,
            message: `Text provider validation failed: ${textValidation.message ?? textValidation.errorType}`,
          };
        }
      }

      // ── Synthesize config + env vars ───────────────────────────────────────
      const priorEnvKeys = readEnvKeys(config.dataDir);
      const { config: wizardCfg, envVars } = synthesizeWizardConfig(
        { code: codeSel, text: textSel, rerank: rerankSel, dataDir: config.dataDir },
        priorEnvKeys
      );

      // ── Write config.json and .env ─────────────────────────────────────────
      writeScrybeConfig(wizardCfg);
      if (Object.keys(envVars).length > 0) {
        writeEnvFile(config.dataDir, envVars);
      }

      // ── Enqueue initial reindex for all registered projects ────────────────
      const projects = listProjects();
      // Whether any configured provider is local (model download deferred to index job)
      const hasLocalProvider = codeSel.provider === "local" || textSel.provider === "local";
      const downloadNote = hasLocalProvider
        ? " The local embedding model will be downloaded during indexing — poll reindex_status to track download + index progress."
        : "";

      if (projects.length === 0) {
        return {
          ok: true,
          status: "configured",
          message:
            "Configuration written. No projects registered yet — " +
            "add a project with add_project + add_source, then call reindex_project.",
        };
      }

      // Route through daemon when available (same path as add_source)
      const daemon = await ensureRunning();
      const jobIds: string[] = [];
      const indexedProjects: string[] = [];

      if (daemon.ok) {
        const client = DaemonClient.fromPidfile();
        if (client) {
          for (const project of projects) {
            for (const source of project.sources) {
              const resp = await client.submitReindex({
                projectId: project.id,
                sourceId: source.source_id,
                mode: "incremental",
              });
              const job = resp.jobs[0];
              if (job) {
                jobIds.push(job.jobId);
                if (!indexedProjects.includes(project.id)) {
                  indexedProjects.push(project.id);
                }
              }
            }
          }
          // Return first job_id; caller can poll any of them (all go through same queue)
          return {
            ok: true,
            status: "configured",
            job_id: jobIds[0],
            indexed_projects: indexedProjects,
            message:
              `Configuration written. Enqueued reindex for ${indexedProjects.length} project(s). ` +
              `Poll reindex_status with job_id "${jobIds[0]}" to track progress.` +
              downloadNote,
          };
        }
      }

      // Fallback: in-process job submission (container / SCRYBE_NO_AUTO_DAEMON)
      for (const project of projects) {
        for (const source of project.sources) {
          const jobResult = submitSourceJob(project.id, source.source_id, "incremental");
          if (typeof jobResult === "string") {
            jobIds.push(jobResult);
            if (!indexedProjects.includes(project.id)) {
              indexedProjects.push(project.id);
            }
          }
        }
      }

      return {
        ok: true,
        status: "configured",
        job_id: jobIds[0],
        indexed_projects: indexedProjects,
        message:
          `Configuration written. Enqueued reindex for ${indexedProjects.length} project(s). ` +
          (jobIds[0]
            ? `Poll reindex_status with job_id "${jobIds[0]}" to track progress.` + downloadNote
            : "Run reindex_all to start indexing."),
      };
    } catch (err: any) {
      return {
        ok: false,
        error: err?.message ?? String(err),
      };
    }
  },
};
