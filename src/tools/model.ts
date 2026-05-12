/**
 * `scrybe model` CLI subcommand tree.
 *
 * Subcommands:
 *   list                                  — print catalog table (providers + models + dim + profile)
 *   show                                  — print current assignments + resolved configs
 *   preset add <name> --provider --model  — write a new preset to config.json
 *   preset rm <name>                      — remove a preset (refuses if assigned or referenced)
 *   assign --code|--text|--rerank         — mutate assignments block
 *   switch --source-type <code|text>      — drop + reindex all sources of that type with current preset
 */

import type { Command } from "commander";
import { PROVIDERS, getProvider, getModel } from "../providers.js";
import {
  readScrybeConfig,
  writeScrybeConfig,
} from "../config.js";
import type { EmbeddingPreset } from "../config.js";
import { resolvePreset } from "../preset-resolver.js";
import { listProjects } from "../registry.js";
import { writeTableMeta } from "../vector-store.js";
import { getPlugin } from "../plugins/index.js";
import { indexSource } from "../indexer.js";
import type { Source } from "../types.js";

// ─── Cost estimate constant ────────────────────────────────────────────────────

/** Conservative avg tokens per chunk (used for remote-provider cost estimate). */
const AVG_TOKENS_PER_CHUNK = 500;

// ─── Remote provider keys — anything not "local" requires API calls ───────────

function isRemoteProvider(providerKey: string): boolean {
  return providerKey !== "local";
}

// ─── Catalog: list ────────────────────────────────────────────────────────────

/**
 * Print the provider catalog as a plain text table.
 * Columns: Provider | Model | Dim | Profile | Notes
 */
export function printCatalogList(): void {
  const COL = { provider: 20, model: 32, dim: 6, profile: 8, notes: 20 };
  const header =
    "Provider".padEnd(COL.provider) +
    "Model".padEnd(COL.model) +
    "Dim".padEnd(COL.dim) +
    "Profile".padEnd(COL.profile) +
    "Notes";
  const sep = "-".repeat(header.length);

  console.log(header);
  console.log(sep);

  for (const [providerKey, spec] of Object.entries(PROVIDERS)) {
    const providerLabel = spec.name;
    let firstModel = true;

    if (Object.keys(spec.embedding_models).length === 0 && providerKey === "custom") {
      // Custom provider — no catalog models; show a placeholder
      const provCol = providerLabel.padEnd(COL.provider);
      const modelCol = "(user-defined)".padEnd(COL.model);
      const dimCol = "-".padEnd(COL.dim);
      const profileCol = "-".padEnd(COL.profile);
      const notes = "base_url + dim required";
      console.log(`${provCol}${modelCol}${dimCol}${profileCol}${notes}`);
      continue;
    }

    for (const [modelName, modelSpec] of Object.entries(spec.embedding_models)) {
      const provCol = (firstModel ? providerLabel : "").padEnd(COL.provider);
      firstModel = false;
      const modelCol = modelName.padEnd(COL.model);
      const dimCol = String(modelSpec.dim).padEnd(COL.dim);
      const profileCol = modelSpec.profile.padEnd(COL.profile);
      const notesParts: string[] = [];
      if (modelSpec.configurable_dim) notesParts.push("configurable dim");
      const notes = notesParts.join(", ");
      console.log(`${provCol}${modelCol}${dimCol}${profileCol}${notes}`);
    }

    // Show rerank models if present
    if (spec.rerank_models) {
      for (const rerankModel of Object.keys(spec.rerank_models)) {
        const provCol = (firstModel ? providerLabel : "").padEnd(COL.provider);
        firstModel = false;
        const modelCol = rerankModel.padEnd(COL.model);
        const dimCol = "-".padEnd(COL.dim);
        const profileCol = "rerank".padEnd(COL.profile);
        console.log(`${provCol}${modelCol}${dimCol}${profileCol}`);
      }
    }
  }
}

// ─── Catalog: show ────────────────────────────────────────────────────────────

/**
 * Print current assignments and resolved configs.
 * Credentials are masked as `${VAR}` or `<set>`/`<unset>`.
 */
export function printModelShow(): void {
  const cfg = readScrybeConfig();
  if (!cfg) {
    console.log("No config.json found. Run 'scrybe model preset add' to create one.");
    return;
  }

  const { assignments, embedding_presets, reranker_presets } = cfg;

  console.log("=== Current Assignments ===\n");
  console.log(`  code_preset   : ${assignments.code_preset}`);
  console.log(`  text_preset   : ${assignments.text_preset}`);
  console.log(`  rerank_preset : ${assignments.rerank_preset ?? "(none)"}`);
  console.log("");

  // Helper: mask a credentials value
  function maskCred(raw: string | undefined): string {
    if (!raw) return "<unset>";
    if (raw.startsWith("${")) return raw; // show the ${VAR} reference as-is
    return raw.length > 0 ? "<set>" : "<unset>";
  }

  // Helper: resolve a preset's resolved credentials status
  function resolvedCredStatus(preset: EmbeddingPreset, allPresets: Record<string, EmbeddingPreset>): string {
    if (preset.credentials_from) {
      const src = allPresets[preset.credentials_from];
      const srcCred = src?.credentials;
      return `from '${preset.credentials_from}': ${maskCred(srcCred)}`;
    }
    return maskCred(preset.credentials);
  }

  // Print embedding presets in assignment order
  const slotsToShow: Array<[string, string, "code_preset" | "text_preset"]> = [
    ["code", assignments.code_preset, "code_preset"],
    ["text", assignments.text_preset, "text_preset"],
  ];

  for (const [slotLabel, presetName, slot] of slotsToShow) {
    const preset = embedding_presets[presetName];
    if (!preset) {
      console.log(`=== ${slotLabel} preset: '${presetName}' (NOT FOUND) ===\n`);
      continue;
    }
    console.log(`=== ${slotLabel} preset: '${presetName}' ===\n`);
    console.log(`  provider    : ${preset.provider}`);
    console.log(`  model       : ${preset.model}`);
    if (preset.provider === "custom") {
      console.log(`  base_url    : ${preset.base_url ?? "(missing)"}`);
      console.log(`  dim         : ${preset.dim ?? "(missing)"}`);
    } else {
      try {
        const pSpec = getProvider(preset.provider);
        const mSpec = getModel(preset.provider, preset.model);
        console.log(`  base_url    : ${pSpec.embedding_base_url ?? "(local)"}`);
        console.log(`  dim         : ${mSpec.dim}`);
        console.log(`  profile     : ${mSpec.profile}`);
      } catch {
        console.log(`  (catalog lookup failed)`);
      }
    }
    console.log(`  credentials : ${resolvedCredStatus(preset, embedding_presets)}`);

    // Try resolving to surface env-var issues
    try {
      process.env["SCRYBE_VOYAGE_API_KEY"] = process.env["SCRYBE_VOYAGE_API_KEY"] ?? "";
      resolvePreset(presetName, slot, cfg);
      console.log(`  resolved    : ok`);
    } catch (err: any) {
      console.log(`  resolved    : ERROR — ${err.message}`);
    }
    console.log("");
  }

  // Print rerank preset if assigned
  if (assignments.rerank_preset) {
    const rPresets = reranker_presets ?? {};
    const rPreset = rPresets[assignments.rerank_preset];
    console.log(`=== rerank preset: '${assignments.rerank_preset}' ===\n`);
    if (!rPreset) {
      console.log(`  (NOT FOUND in reranker_presets)\n`);
    } else {
      console.log(`  provider    : ${rPreset.provider}`);
      console.log(`  model       : ${rPreset.model}`);
      if (rPreset.credentials_from) {
        const src = embedding_presets[rPreset.credentials_from];
        console.log(`  credentials : from '${rPreset.credentials_from}': ${maskCred(src?.credentials)}`);
      } else {
        console.log(`  credentials : ${maskCred(rPreset.credentials)}`);
      }
      console.log("");
    }
  }
}

// ─── preset add ───────────────────────────────────────────────────────────────

export interface PresetAddOptions {
  name: string;
  provider: string;
  model: string;
  credentials?: string;
  credentialsFrom?: string;
  baseUrl?: string;
  dim?: number;
}

/**
 * Add a new embedding preset to config.json.
 * Validates provider + model against the catalog (except for custom provider).
 */
export function runPresetAdd(opts: PresetAddOptions): void {
  const { name, provider, model, credentials, credentialsFrom, baseUrl, dim } = opts;

  const isCustom = provider === "custom";

  if (!isCustom) {
    // Validate against catalog
    try {
      getProvider(provider);
    } catch {
      throw new Error(`Unknown provider: "${provider}". Run 'scrybe model list' to see available providers.`);
    }
    if (baseUrl !== undefined) {
      throw new Error(`--base-url is only valid for custom providers. Catalog providers derive base_url from the catalog.`);
    }
    if (dim !== undefined) {
      throw new Error(`--dim is only valid for custom providers. Catalog providers derive dim from the model spec.`);
    }
    // Validate model exists in catalog
    try {
      getModel(provider, model);
    } catch {
      throw new Error(`Model "${model}" not found in provider "${provider}". Run 'scrybe model list' to see available models.`);
    }
  } else {
    // Custom provider — require base_url and dim
    if (!baseUrl) {
      throw new Error(`--base-url is required for custom providers.`);
    }
    if (dim === undefined) {
      throw new Error(`--dim is required for custom providers.`);
    }
  }

  // Load or create config
  let cfg = readScrybeConfig();
  if (!cfg) {
    cfg = {
      schema_version: 1,
      embedding_presets: {},
      assignments: {
        code_preset: "",
        text_preset: "",
      },
    };
  }

  // Build the preset
  const preset: EmbeddingPreset = { provider, model };
  if (credentials) preset.credentials = credentials;
  if (credentialsFrom) preset.credentials_from = credentialsFrom;
  if (isCustom) {
    preset.base_url = baseUrl;
    preset.dim = dim;
  }

  cfg.embedding_presets[name] = preset;
  writeScrybeConfig(cfg);
  console.log(`Preset '${name}' added to config.json.`);
}

// ─── preset rm ────────────────────────────────────────────────────────────────

export function runPresetRm(name: string): void {
  const cfg = readScrybeConfig();
  if (!cfg) throw new Error("No config.json found. Nothing to remove.");

  if (!(name in cfg.embedding_presets)) {
    throw new Error(`Preset '${name}' not found in embedding_presets.`);
  }

  // Check if currently assigned
  const { code_preset, text_preset } = cfg.assignments;
  if (code_preset === name || text_preset === name || cfg.assignments.rerank_preset === name) {
    throw new Error(
      `Cannot remove preset '${name}': it is currently assigned. ` +
      `Use 'scrybe model assign' to switch to a different preset first.`
    );
  }

  // Check if referenced by credentials_from in any other preset
  for (const [pName, p] of Object.entries(cfg.embedding_presets)) {
    if (p.credentials_from === name) {
      throw new Error(
        `Cannot remove preset '${name}': it is referenced via credentials_from by preset '${pName}'.`
      );
    }
  }
  // Check reranker_presets too
  if (cfg.reranker_presets) {
    for (const [pName, p] of Object.entries(cfg.reranker_presets)) {
      if (p.credentials_from === name) {
        throw new Error(
          `Cannot remove preset '${name}': it is referenced via credentials_from by reranker preset '${pName}'.`
        );
      }
    }
  }

  delete cfg.embedding_presets[name];
  writeScrybeConfig(cfg);
  console.log(`Preset '${name}' removed from config.json.`);
}

// ─── assign ───────────────────────────────────────────────────────────────────

export interface AssignOptions {
  code?: string;
  text?: string;
  rerank?: string; // "none" to clear
}

export function runAssign(opts: AssignOptions): void {
  const cfg = readScrybeConfig();
  if (!cfg) throw new Error("No config.json found. Run 'scrybe model preset add' first.");

  if (opts.code !== undefined) {
    if (!(opts.code in cfg.embedding_presets)) {
      throw new Error(`Preset '${opts.code}' not found in embedding_presets.`);
    }
    // Cross-profile validation via resolvePreset (throws on mismatch)
    resolvePreset(opts.code, "code_preset", cfg);
    cfg.assignments.code_preset = opts.code;
  }

  if (opts.text !== undefined) {
    if (!(opts.text in cfg.embedding_presets)) {
      throw new Error(`Preset '${opts.text}' not found in embedding_presets.`);
    }
    // Cross-profile validation via resolvePreset (throws on mismatch)
    resolvePreset(opts.text, "text_preset", cfg);
    cfg.assignments.text_preset = opts.text;
  }

  if (opts.rerank !== undefined) {
    if (opts.rerank === "none") {
      delete cfg.assignments.rerank_preset;
      console.log("Rerank preset cleared.");
    } else {
      const rPresets = cfg.reranker_presets ?? {};
      if (!(opts.rerank in rPresets)) {
        throw new Error(`Reranker preset '${opts.rerank}' not found in reranker_presets.`);
      }
      cfg.assignments.rerank_preset = opts.rerank;
    }
  }

  writeScrybeConfig(cfg);
  console.log("Assignments updated in config.json.");
}

// ─── switch ───────────────────────────────────────────────────────────────────

/** Average chunk row count estimate for cost estimate (used when table doesn't exist yet). */
const FALLBACK_CHUNK_ESTIMATE = 0;

export async function runSwitch(
  sourceType: "code" | "text",
  opts: { yes?: boolean } = {}
): Promise<void> {
  const cfg = readScrybeConfig();
  if (!cfg) throw new Error("No config.json found. Run 'scrybe model preset add' and assign presets first.");

  const presetName = sourceType === "code" ? cfg.assignments.code_preset : cfg.assignments.text_preset;
  if (!presetName) {
    throw new Error(`No ${sourceType} preset assigned. Run 'scrybe model assign --${sourceType} <preset>' first.`);
  }

  // Resolve the preset (validates credentials etc.)
  const slot = sourceType === "code" ? "code_preset" as const : "text_preset" as const;
  const resolved = resolvePreset(presetName, slot, cfg);

  // Collect all sources of matching type
  const projects = listProjects();
  interface SwitchTarget {
    projectId: string;
    source: Source;
    currentChunks: number;
  }
  const targets: SwitchTarget[] = [];

  for (const project of projects) {
    for (const source of project.sources) {
      const plugin = getPlugin(source.source_config.type);
      if (plugin.embeddingProfile !== sourceType) continue;
      // Count existing chunks for cost estimate
      let currentChunks = FALLBACK_CHUNK_ESTIMATE;
      if (source.table_name) {
        try {
          const { countTableRows } = await import("../vector-store.js");
          currentChunks = await countTableRows(source.table_name);
        } catch { /* table may not exist */ }
      }
      targets.push({ projectId: project.id, source, currentChunks });
    }
  }

  if (targets.length === 0) {
    console.log(`No ${sourceType} sources found. Nothing to switch.`);
    return;
  }

  const totalChunks = targets.reduce((sum, t) => sum + t.currentChunks, 0);

  // Print cost summary
  console.log(`\nSwitching ${targets.length} ${sourceType} source(s) to preset '${presetName}':`);
  console.log(`  Provider : ${resolved.provider}`);
  console.log(`  Model    : ${resolved.model}`);
  console.log(`  Dim      : ${resolved.dim}`);
  console.log("");

  for (const t of targets) {
    console.log(`  ${t.projectId}/${t.source.source_id}  (${t.currentChunks} chunks currently indexed)`);
  }

  if (isRemoteProvider(resolved.provider) && totalChunks > 0) {
    const tokenEstimate = totalChunks * AVG_TOKENS_PER_CHUNK;
    console.log(
      `\n  Estimated tokens to re-embed: ~${tokenEstimate.toLocaleString()} ` +
      `(${totalChunks} chunks × ${AVG_TOKENS_PER_CHUNK} tokens avg). ` +
      `Check your provider's pricing for cost.`
    );
  }

  console.log(
    "\n  This will drop and fully reindex the affected tables. " +
    "All existing vectors will be replaced."
  );

  // Confirmation prompt
  if (!opts.yes) {
    if (!process.stdin.isTTY) {
      throw new Error("Non-interactive input. Pass --yes to confirm without a prompt.");
    }
    process.stdout.write(`\nSwitch ${targets.length} source(s)? [y/N] `);
    const confirmed = await new Promise<boolean>((resolve) => {
      process.stdin.once("data", (data) => {
        process.stdin.pause();
        resolve(data.toString().trim().toLowerCase() === "y");
      });
    });
    if (!confirmed) {
      console.log("Aborted.");
      return;
    }
  }

  console.log("\nReindexing...");
  let failed = 0;

  for (const t of targets) {
    const label = `${t.projectId}/${t.source.source_id}`;
    process.stdout.write(`  ${label}...`);
    try {
      await indexSource(t.projectId, t.source.source_id, "full", {
        onScanProgress(n) { process.stdout.write(`\r  ${label}... scanning ${n} files`); },
        onEmbedProgress(n) { process.stdout.write(`\r  ${label}... embedding ${n} chunks`); },
      });
      process.stdout.write("\n");

      // Write model-provenance fields into the sidecar via read-modify-write
      const tableSource = t.source;
      if (tableSource.table_name) {
        writeTableMeta(tableSource.table_name, {
          model: resolved.model,
          dim: resolved.dim,
          provider: resolved.provider,
          preset_at_index_time: presetName,
          indexed_at: new Date().toISOString(),
        });
      }

      console.log(`    Done.`);
    } catch (err: any) {
      process.stdout.write("\n");
      console.error(`    Failed: ${err.message}`);
      failed++;
    }
  }

  if (failed > 0) {
    console.error(`\n${failed} source(s) failed. Run 'scrybe doctor' for diagnostics.`);
    process.exit(1);
  } else {
    console.log(`\nAll ${targets.length} source(s) reindexed with preset '${presetName}'.`);
  }

  console.log(
    "\nTables recreated. If an MCP client (Claude Code, Cline) is connected, restart it to pick up the new tables."
  );
}

// ─── CLI wiring helper ────────────────────────────────────────────────────────

/**
 * Register the `scrybe model` subcommand tree on the given program Command.
 * Called from `src/cli.ts` after creating the main program.
 */
export function registerModelCommand(program: Command): void {
  const modelGroup = program.command("model").description("Manage embedding model presets and assignments");

  // ─── model list ──────────────────────────────────────────────────────────

  modelGroup
    .command("list")
    .description("Show all available providers and models from the built-in catalog")
    .action(() => {
      try {
        printCatalogList();
      } catch (err: any) {
        console.error(`[scrybe] ${err.message}`);
        process.exit(1);
      }
    });

  // ─── model show ──────────────────────────────────────────────────────────

  modelGroup
    .command("show")
    .description("Show current assignments and resolved embedding configuration")
    .action(() => {
      try {
        printModelShow();
      } catch (err: any) {
        console.error(`[scrybe] ${err.message}`);
        process.exit(1);
      }
    });

  // ─── model preset ────────────────────────────────────────────────────────

  const presetGroup = modelGroup.command("preset").description("Manage named embedding presets");

  presetGroup
    .command("add <name>")
    .description("Add a new embedding preset to config.json")
    .requiredOption("--provider <provider>", "Provider key (voyage, openai, local, custom)")
    .requiredOption("--model <model>", "Model name from provider catalog")
    .option("--credentials <ref>", "Credential reference (literal value or ${ENV_VAR})")
    .option("--credentials-from <preset>", "Reuse credentials from another named preset")
    .option("--base-url <url>", "API base URL (custom provider only)")
    .option("--dim <n>", "Embedding dimensions (custom provider only)", (v) => parseInt(v, 10))
    .addHelpText(
      "after",
      "\nExamples:\n" +
      "  scrybe model preset add voyage-code --provider voyage --model voyage-code-3 --credentials '${SCRYBE_VOYAGE_API_KEY}'\n" +
      "  scrybe model preset add together-bert --provider custom --model bert-model --base-url https://api.together.xyz/v1 --dim 768 --credentials '${SCRYBE_TOGETHER_API_KEY}'"
    )
    .action((name: string, opts: { provider: string; model: string; credentials?: string; credentialsFrom?: string; baseUrl?: string; dim?: number }) => {
      try {
        runPresetAdd({
          name,
          provider: opts.provider,
          model: opts.model,
          credentials: opts.credentials,
          credentialsFrom: opts.credentialsFrom,
          baseUrl: opts.baseUrl,
          dim: opts.dim,
        });
      } catch (err: any) {
        console.error(`[scrybe] ${err.message}`);
        process.exit(1);
      }
    });

  presetGroup
    .command("rm <name>")
    .alias("remove")
    .description("Remove an embedding preset from config.json")
    .addHelpText("after", "\nExample:\n  scrybe model preset rm old-voyage-preset")
    .action((name: string) => {
      try {
        runPresetRm(name);
      } catch (err: any) {
        console.error(`[scrybe] ${err.message}`);
        process.exit(1);
      }
    });

  // ─── model assign ────────────────────────────────────────────────────────

  modelGroup
    .command("assign")
    .description("Assign presets to embedding slots (code, text, rerank)")
    .option("--code <preset>", "Preset name to assign to the code embedding slot")
    .option("--text <preset>", "Preset name to assign to the text embedding slot")
    .option("--rerank <preset|none>", "Reranker preset name, or 'none' to clear")
    .addHelpText(
      "after",
      "\nExamples:\n" +
      "  scrybe model assign --code voyage-code\n" +
      "  scrybe model assign --text local-default\n" +
      "  scrybe model assign --rerank none"
    )
    .action((opts: { code?: string; text?: string; rerank?: string }) => {
      if (!opts.code && !opts.text && !opts.rerank) {
        console.error("[scrybe] At least one of --code, --text, or --rerank must be specified.");
        process.exit(1);
      }
      try {
        runAssign(opts);
      } catch (err: any) {
        console.error(`[scrybe] ${err.message}`);
        process.exit(1);
      }
    });

  // ─── model switch ────────────────────────────────────────────────────────

  modelGroup
    .command("switch")
    .description("Drop and reindex all sources of a given type using the current preset assignment")
    .requiredOption("--source-type <type>", "Source type to switch: code or text")
    .option("-y, --yes", "Skip confirmation prompt", false)
    .addHelpText(
      "after",
      "\nExamples:\n" +
      "  scrybe model switch --source-type code\n" +
      "  scrybe model switch --source-type text --yes"
    )
    .action(async (opts: { sourceType: string; yes: boolean }) => {
      const st = opts.sourceType;
      if (st !== "code" && st !== "text") {
        console.error(`[scrybe] --source-type must be 'code' or 'text', got: '${st}'`);
        process.exit(1);
      }
      try {
        await runSwitch(st as "code" | "text", { yes: opts.yes });
      } catch (err: any) {
        console.error(`[scrybe] ${err.message}`);
        process.exit(1);
      }
    });
}
