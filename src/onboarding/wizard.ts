import { existsSync, writeFileSync, readFileSync, mkdirSync } from "fs";
import { join, resolve, basename } from "path";
import * as p from "@clack/prompts";
import { formatProgressLine, updateThroughput } from "./progress-renderer.js";
import type { ProgressState } from "./progress-renderer.js";
import type { ScrybeConfig, EmbeddingPreset, RerankerPreset, ScrybeConfigAssignments } from "../config.js";

export interface WizardOptions {
  registerOnly?: boolean;
}

// ─── Env-file writer ──────────────────────────────────────────────────────────

/**
 * Merge `vars` into `<dataDir>/.env`. Preserves existing unrelated keys and
 * comment / blank lines. Overwrites existing values for matching keys.
 * Never writes a key whose value is empty.
 */
export function writeEnvFile(dataDir: string, vars: Record<string, string>): void {
  mkdirSync(dataDir, { recursive: true });
  const envPath = join(dataDir, ".env");

  // Parse existing file preserving structure (comments, blanks, ordering)
  type Line = { raw: string; key?: string };
  const lines: Line[] = [];
  const existingKeys = new Set<string>();

  if (existsSync(envPath)) {
    for (const raw of readFileSync(envPath, "utf8").split("\n")) {
      const trimmed = raw.trim();
      if (!trimmed || trimmed.startsWith("#")) {
        lines.push({ raw });
        continue;
      }
      const eq = trimmed.indexOf("=");
      if (eq <= 0) { lines.push({ raw }); continue; }
      const key = trimmed.slice(0, eq).trim();
      lines.push({ raw, key });
      existingKeys.add(key);
    }
  }

  // Overwrite existing key lines in place
  const newVars = { ...vars };
  for (const line of lines) {
    if (line.key && newVars[line.key] !== undefined) {
      line.raw = `${line.key}=${newVars[line.key]}`;
      delete newVars[line.key];
    }
  }

  // Append remaining new keys
  for (const [k, v] of Object.entries(newVars)) {
    if (v) lines.push({ raw: `${k}=${v}` });
  }

  // Ensure single trailing newline
  const content = lines.map((l) => l.raw).join("\n").replace(/\n+$/, "") + "\n";
  writeFileSync(envPath, content, "utf8");
}

/**
 * Read existing keys from `<dataDir>/.env`. Used for slug collision detection.
 */
export function readEnvKeys(dataDir: string): Set<string> {
  const envPath = join(dataDir, ".env");
  const keys = new Set<string>();
  if (!existsSync(envPath)) return keys;
  for (const raw of readFileSync(envPath, "utf8").split("\n")) {
    const trimmed = raw.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;
    const eq = trimmed.indexOf("=");
    if (eq > 0) keys.add(trimmed.slice(0, eq).trim());
  }
  return keys;
}

// ─── Provider key naming ──────────────────────────────────────────────────────

/**
 * Returns the env-var name for a catalog provider: `SCRYBE_<PROVIDER>_API_KEY`.
 */
export function catalogKeyName(providerKey: string): string {
  return `SCRYBE_${providerKey.toUpperCase()}_API_KEY`;
}

/**
 * Derives a slug from a custom base URL hostname.
 * e.g. `api.together.xyz` → `together`, `api.openai.com` → `openai`.
 * Lowercased, non-alphanumeric stripped.
 */
export function slugFromBaseUrl(baseUrl: string): string {
  try {
    const { hostname } = new URL(baseUrl);
    const parts = hostname.split(".");
    // Second-to-last part is the domain name (before TLD)
    const domain = parts.length >= 2 ? parts[parts.length - 2] : parts[0];
    return (domain ?? "custom").toLowerCase().replace(/[^a-z0-9]/g, "");
  } catch {
    return "custom";
  }
}

/**
 * Returns a unique `SCRYBE_CUSTOM_<slug>_API_KEY` name, appending `_2`, `_3`…
 * on collision with keys already present in `existingKeys`.
 */
export function customKeyName(baseUrl: string, existingKeys: Set<string>): string {
  const slug = slugFromBaseUrl(baseUrl).toUpperCase();
  const base = `SCRYBE_CUSTOM_${slug}_API_KEY`;
  if (!existingKeys.has(base)) return base;
  for (let i = 2; i < 100; i++) {
    const candidate = `SCRYBE_CUSTOM_${slug}_${i}_API_KEY`;
    if (!existingKeys.has(candidate)) return candidate;
  }
  return `SCRYBE_CUSTOM_${slug}_99_API_KEY`;
}

// ─── Synthesize config ────────────────────────────────────────────────────────

export interface ProviderSelection {
  provider: string;
  /** Resolved API key value (plain string, not env-ref). Empty for local. */
  apiKey: string;
  model: string;
  /** Custom providers only */
  baseUrl?: string;
  /** Custom providers only */
  dim?: number;
}

export interface WizardInput {
  code: ProviderSelection;
  text: ProviderSelection;
  rerank?: {
    provider: string;
    model: string;
  };
  dataDir: string;
}

export interface WizardOutput {
  config: ScrybeConfig;
  /** Env vars to write: key → value (plain strings, not env-refs). */
  envVars: Record<string, string>;
}

/**
 * Pure function: given user selections, build the ScrybeConfig + env var map.
 * Does NOT write to disk. Handles:
 * - Catalog preset naming: `${provider}-${profile}` (e.g. `voyage-code`, `openai-text`).
 * - Custom preset naming: `${slug}-${profile}` (e.g. `together-code`).
 * - `credentials_from` when rerank reuses an embedding preset's provider/key.
 * - Slug collision detection against already-emitted env vars (passed in via `priorEnvKeys`).
 */
export function synthesizeWizardConfig(input: WizardInput, priorEnvKeys?: Set<string>): WizardOutput {
  const envVars: Record<string, string> = {};
  const embeddingPresets: Record<string, EmbeddingPreset> = {};
  const rerankerPresets: Record<string, RerankerPreset> = {};

  // Track env var names we'll emit so slug collision detection can see them
  const emittedKeys = new Set<string>(priorEnvKeys ?? []);

  function presetNameForSelection(sel: ProviderSelection, profile: "code" | "text"): string {
    if (sel.provider === "custom") {
      const slug = slugFromBaseUrl(sel.baseUrl ?? "");
      return `${slug}-${profile}`;
    }
    return `${sel.provider}-${profile}`;
  }

  function resolveEnvVarName(sel: ProviderSelection): string {
    if (sel.provider === "local" || !sel.apiKey) return "";
    if (sel.provider === "custom") {
      const name = customKeyName(sel.baseUrl ?? "", emittedKeys);
      emittedKeys.add(name);
      return name;
    }
    return catalogKeyName(sel.provider);
  }

  function buildEmbeddingPreset(sel: ProviderSelection, envVarName: string): EmbeddingPreset {
    const preset: EmbeddingPreset = {
      provider: sel.provider,
      model: sel.model,
    };
    if (envVarName) {
      preset.credentials = `\${${envVarName}}`;
    }
    if (sel.provider === "custom") {
      if (sel.baseUrl) preset.base_url = sel.baseUrl;
      if (sel.dim !== undefined) preset.dim = sel.dim;
    }
    return preset;
  }

  // Code preset
  const codeEnvVar = resolveEnvVarName(input.code);
  const codePresetName = presetNameForSelection(input.code, "code");
  embeddingPresets[codePresetName] = buildEmbeddingPreset(input.code, codeEnvVar);
  if (codeEnvVar && input.code.apiKey) {
    envVars[codeEnvVar] = input.code.apiKey;
  }

  // Text preset (may reuse the same provider/key as code)
  const textPresetName = presetNameForSelection(input.text, "text");
  let textEnvVar = codeEnvVar;

  const textIsSameProvider = input.text.provider === input.code.provider &&
    input.text.provider !== "custom";
  const textIsSameCustom = input.text.provider === "custom" &&
    input.code.provider === "custom" &&
    input.text.baseUrl === input.code.baseUrl;

  if (textIsSameProvider || textIsSameCustom) {
    // Same provider — reuse the same env var (no new entry)
  } else {
    textEnvVar = resolveEnvVarName(input.text);
    if (textEnvVar && input.text.apiKey) {
      envVars[textEnvVar] = input.text.apiKey;
    }
  }

  if (textPresetName !== codePresetName) {
    embeddingPresets[textPresetName] = buildEmbeddingPreset(input.text, textEnvVar);
  }

  // Rerank preset
  const assignments: ScrybeConfigAssignments = {
    code_preset: codePresetName,
    text_preset: textPresetName,
  };

  if (input.rerank) {
    const rerankPresetName = `${input.rerank.provider}-rerank`;
    // If the rerank provider matches an embedding preset's provider, use credentials_from
    const matchingEmbeddingPreset =
      Object.entries(embeddingPresets).find(([, ep]) => ep.provider === input.rerank!.provider);
    const rerankPreset: RerankerPreset = {
      provider: input.rerank.provider,
      model: input.rerank.model,
    };
    if (matchingEmbeddingPreset) {
      rerankPreset.credentials_from = matchingEmbeddingPreset[0];
    } else {
      // Rerank uses a different provider — give it its own env var
      const rerankEnvVar = catalogKeyName(input.rerank.provider);
      rerankPreset.credentials = `\${${rerankEnvVar}}`;
      // Note: we don't have the actual key value here (wizard would have collected it)
    }
    rerankerPresets[rerankPresetName] = rerankPreset;
    assignments.rerank_preset = rerankPresetName;
  }

  const cfg: ScrybeConfig = {
    schema_version: 1,
    embedding_presets: embeddingPresets,
    assignments,
  };
  if (Object.keys(rerankerPresets).length > 0) {
    cfg.reranker_presets = rerankerPresets;
  }

  return { config: cfg, envVars };
}

// ─── Interactive wizard (provider step only, replaces old Step 1) ─────────────

/**
 * Probes `GET <baseUrl>/models` with a 5-second timeout.
 * Returns the list of model IDs on 200; null on error/auth failure.
 * Re-throw is suppressed — callers handle null as "probe failed".
 */
export async function probeModelsEndpoint(
  baseUrl: string,
  apiKey: string
): Promise<{ models: string[]; status: number } | null> {
  const url = `${baseUrl.replace(/\/$/, "")}/models`;
  try {
    const resp = await fetch(url, {
      headers: { Authorization: `Bearer ${apiKey}` },
      signal: AbortSignal.timeout(5000),
    });
    if (!resp.ok) return { models: [], status: resp.status };
    const data = (await resp.json()) as { data?: Array<{ id: string }> } | { models?: string[] };
    const models =
      (data as any)?.data?.map((m: { id: string }) => m.id) ??
      (data as any)?.models ??
      [];
    return { models, status: resp.status };
  } catch {
    return null;
  }
}

export async function runWizard(opts?: WizardOptions): Promise<void> {
  const { config, writeScrybeConfig } = await import("../config.js");
  const { listProjects, addProject } = await import("../registry.js");
  const { addSource } = await import("../registry.js");
  const { validateProvider } = await import("./validate-provider.js");
  const { discoverRepos } = await import("./repo-discovery.js");
  const { generateScrybeIgnore } = await import("./scrybeignore.js");
  const { detectMcpConfigs, proposeScrybeEntry, computeDiff, applyMcpMerge } = await import("./mcp-config.js");
  const { indexProject } = await import("../indexer.js");
  const { PROVIDERS: CATALOG } = await import("../providers.js");

  p.intro("Scrybe setup wizard");

  // ── Step 1: Model / Provider configuration ─────────────────────────────────

  const providerOptions = [
    { value: "local", label: "Local (in-process)", hint: "no API key, offline — recommended for most users" },
    { value: "voyage", label: "Voyage AI", hint: "free tier, code-optimized" },
    { value: "openai", label: "OpenAI", hint: "text-embedding-3-small" },
    { value: "custom", label: "Custom (OpenAI-compatible)", hint: "any OpenAI-compatible endpoint" },
  ];

  async function collectProviderSelection(
    profile: "code" | "text",
    priorCode?: ProviderSelection
  ): Promise<ProviderSelection | null> {
    const profileLabel = profile === "code" ? "code sources" : "text / knowledge sources";

    // If collecting text and code was already set, offer "same as code"
    const options =
      priorCode && priorCode.provider !== "custom"
        ? [
            {
              value: "__same",
              label: `Same as code (${priorCode.provider})`,
              hint: "reuse the same provider and key",
            },
            ...providerOptions,
          ]
        : providerOptions;

    const providerValue = await p.select({
      message: `Provider for ${profileLabel}`,
      options,
      initialValue: priorCode ? "__same" : "local",
    });
    if (p.isCancel(providerValue)) return null;

    if (providerValue === "__same") {
      // text profile uses the same provider/key as code, but may need a different model
      const codeProvider = priorCode!.provider;
      const provSpec = CATALOG[codeProvider];
      const textModels = Object.entries(provSpec?.embedding_models ?? {}).filter(
        ([, ms]) => ms.profile === "text"
      );
      if (textModels.length === 0) {
        return { ...priorCode!, model: priorCode!.model };
      }
      const modelChoice = await p.select({
        message: `Model for text / knowledge sources (${codeProvider})`,
        options: textModels.map(([id, ms]) => ({
          value: id,
          label: id,
          hint: `${ms.dim}d`,
        })),
        initialValue: textModels[0]![0],
      });
      if (p.isCancel(modelChoice)) return null;
      return { ...priorCode!, model: modelChoice as string };
    }

    const selectedProvider = providerValue as string;
    const provSpec = CATALOG[selectedProvider];

    if (selectedProvider === "local") {
      const { LOCAL_PROVIDER_DEFAULTS } = await import("../providers.js");
      const modelModels = Object.keys(provSpec?.embedding_models ?? {});
      const modelChoice = modelModels.length > 0
        ? await p.select({
            message: `Local model for ${profileLabel}`,
            options: modelModels.map((id) => ({
              value: id,
              label: id,
              hint: `${(provSpec!.embedding_models[id]!).dim}d`,
            })),
            initialValue: LOCAL_PROVIDER_DEFAULTS.model,
          })
        : LOCAL_PROVIDER_DEFAULTS.model;
      if (p.isCancel(modelChoice)) return null;
      return { provider: "local", apiKey: "", model: modelChoice as string };
    }

    if (selectedProvider === "custom") {
      return await collectCustomSelection(profile);
    }

    // Catalog provider (voyage, openai, etc.)
    const catalogModels = Object.entries(provSpec?.embedding_models ?? {}).filter(
      ([, ms]) => ms.profile === profile || profile === "text"
    );
    if (catalogModels.length === 0) {
      p.log.warn(`No ${profile}-profile models found for this provider. Using first available.`);
    }
    const filteredModels = catalogModels.length > 0
      ? catalogModels
      : Object.entries(provSpec?.embedding_models ?? {});

    const modelChoice = await p.select({
      message: `Model for ${profileLabel}`,
      options: filteredModels.map(([id, ms]) => ({
        value: id,
        label: id,
        hint: `${ms.dim}d`,
      })),
      initialValue: filteredModels[0]![0],
    });
    if (p.isCancel(modelChoice)) return null;

    // API key — offer "use existing" if the provider env var is already set
    const keyEnvName = catalogKeyName(selectedProvider);
    const existingKey = process.env[keyEnvName];
    let apiKey: string;

    if (existingKey) {
      const useExisting = await p.confirm({
        message: `${keyEnvName} is already set. Use existing key?`,
        initialValue: true,
      });
      if (p.isCancel(useExisting)) return null;
      apiKey = useExisting ? existingKey : await promptNewApiKey(selectedProvider, {
        baseUrl: provSpec?.embedding_base_url ?? "",
        model: modelChoice as string,
      });
    } else {
      apiKey = await promptNewApiKey(selectedProvider, {
        baseUrl: provSpec?.embedding_base_url ?? "",
        model: modelChoice as string,
      });
    }
    if (!apiKey) return null; // cancel propagated as empty

    return {
      provider: selectedProvider,
      apiKey,
      model: modelChoice as string,
    };
  }

  async function collectCustomSelection(_profile: "code" | "text"): Promise<ProviderSelection | null> {
    const baseUrlInput = await p.text({
      message: "Custom API base URL (e.g. https://api.together.xyz/v1)",
      validate: (v) => (v?.startsWith("http") ? undefined : "Must start with http:// or https://"),
    });
    if (p.isCancel(baseUrlInput)) return null;
    const baseUrl = baseUrlInput as string;

    // API key
    const keyInput = await p.password({
      message: "API key",
      validate: (v) => (v?.trim() ? undefined : "Key cannot be empty"),
    });
    if (p.isCancel(keyInput)) return null;
    let apiKey = (keyInput as string).trim();

    // Probe /models — retry on 401
    let model = "";
    let dim: number | undefined;

    const probeResult = await probeModelsEndpoint(baseUrl, apiKey);
    if (probeResult && probeResult.status === 401) {
      p.log.warn("API key rejected (401). Please re-enter.");
      const retryKey = await p.password({
        message: "API key (retry)",
        validate: (v) => (v?.trim() ? undefined : "Key cannot be empty"),
      });
      if (p.isCancel(retryKey)) return null;
      apiKey = (retryKey as string).trim();
    }

    const finalProbe = probeResult?.status === 401
      ? await probeModelsEndpoint(baseUrl, apiKey)
      : probeResult;

    if (finalProbe?.models && finalProbe.models.length > 0) {
      const modelChoice = await p.select({
        message: "Model",
        options: finalProbe.models.map((id) => ({ value: id, label: id })),
        initialValue: finalProbe.models[0],
      });
      if (p.isCancel(modelChoice)) return null;
      model = modelChoice as string;
    } else {
      const modelInput = await p.text({ message: "Model name (e.g. nomic-embed-text)" });
      if (p.isCancel(modelInput)) return null;
      model = modelInput as string;
    }

    const dimInput = await p.text({
      message: "Embedding dimensions (e.g. 768)",
      validate: (v) => (v && /^\d+$/.test(v) ? undefined : "Must be a positive integer"),
    });
    if (p.isCancel(dimInput)) return null;
    dim = parseInt(dimInput as string, 10);

    return { provider: "custom", apiKey, model, baseUrl, dim };
  }

  async function promptNewApiKey(
    providerLabel: string,
    spec: { baseUrl: string; model: string }
  ): Promise<string> {
    const keyInput = await p.password({
      message: `API key for ${providerLabel}`,
      validate: (v) => (v?.trim() ? undefined : "Key cannot be empty"),
    });
    if (p.isCancel(keyInput)) return "";

    const apiKey = (keyInput as string).trim();
    const spinner = p.spinner();
    spinner.start("Validating API key...");
    const result = await validateProvider({ baseUrl: spec.baseUrl, model: spec.model, apiKey });
    if (!result.ok) {
      spinner.stop(`Validation failed: ${result.message}`);
      p.log.warn("Key may be invalid — continuing anyway. Run `scrybe doctor` to verify.");
    } else {
      spinner.stop(`API key valid — ${result.dimensions}d`);
    }
    return apiKey;
  }

  // Collect code provider
  const codeSelection = await collectProviderSelection("code");
  if (!codeSelection) { p.cancel("Setup cancelled."); return; }

  // Collect text provider
  const textSelection = await collectProviderSelection("text", codeSelection);
  if (!textSelection) { p.cancel("Setup cancelled."); return; }

  // Rerank — only if any selected provider supports it
  const selectedProviders = new Set([codeSelection.provider, textSelection.provider]);
  const rerankProviders = Object.entries(CATALOG)
    .filter(([k, spec]) => selectedProviders.has(k) && spec.rerank_models && Object.keys(spec.rerank_models).length > 0);

  let rerankSelection: WizardInput["rerank"] | undefined;
  if (rerankProviders.length > 0) {
    const enableRerank = await p.confirm({
      message: "Enable reranker? (improves search quality — requires additional API call per query)",
      initialValue: false,
    });
    if (p.isCancel(enableRerank)) { p.cancel("Setup cancelled."); return; }

    if (enableRerank) {
      const rerankModels: Array<{ value: string; label: string; provider: string }> = [];
      for (const [provKey, spec] of rerankProviders) {
        for (const modelKey of Object.keys(spec.rerank_models!)) {
          rerankModels.push({ value: `${provKey}::${modelKey}`, label: `${spec.name} — ${modelKey}`, provider: provKey });
        }
      }
      const rerankChoice = await p.select({
        message: "Rerank model",
        options: rerankModels.map(({ value, label }) => ({ value, label })),
        initialValue: rerankModels[0]!.value,
      });
      if (p.isCancel(rerankChoice)) { p.cancel("Setup cancelled."); return; }
      const [rerankProvider, rerankModel] = (rerankChoice as string).split("::");
      rerankSelection = { provider: rerankProvider!, model: rerankModel! };
    }
  }

  // Synthesize config + env vars
  const existingEnvKeys = readEnvKeys(config.dataDir);
  const { config: wizardCfg, envVars } = synthesizeWizardConfig(
    { code: codeSelection, text: textSelection, rerank: rerankSelection, dataDir: config.dataDir },
    existingEnvKeys
  );

  // Write config.json
  writeScrybeConfig(wizardCfg);
  p.log.success(`Model configuration saved to ${config.dataDir}/config.json`);

  // Write .env
  if (Object.keys(envVars).length > 0) {
    writeEnvFile(config.dataDir, envVars);
    p.log.success(`Credentials saved to ${config.dataDir}/.env`);
  }

  // ── Step 2: Repo discovery ─────────────────────────────────────────────────
  const existingProjects = listProjects();
  const existingRoots = new Set(
    existingProjects.flatMap((p2) =>
      p2.sources
        .filter((s) => s.source_config.type === "code")
        .map((s) => resolve((s.source_config as any).root_path))
    )
  );

  const { defaultRoots } = await import("./repo-discovery.js");
  const vscPaths = defaultRoots();
  const rootChoices = [
    ...(vscPaths.length > 0
      ? [{ value: "__auto", label: `Auto-detect (VS Code recents, ${vscPaths.length} path${vscPaths.length !== 1 ? "s" : ""})` }]
      : []),
    { value: "__manual", label: "Enter a directory" },
    { value: "__skip", label: "Skip — I'll add projects manually later" },
  ];
  const rootChoice = await p.select({
    message: "Choose repos — Where are your projects stored?",
    options: rootChoices,
    initialValue: vscPaths.length > 0 ? "__auto" : "__manual",
  });
  if (p.isCancel(rootChoice)) { p.cancel("Setup cancelled."); return; }

  let userRoots: string[] = [];
  if (rootChoice === "__auto") {
    userRoots = vscPaths;
  } else if (rootChoice === "__manual") {
    const entered = await p.text({
      message: "Directory containing your git repos (e.g. ~/code, C:\\Users\\me\\src)",
      validate: (v) => {
        if (!v) return "Path required";
        const resolved = resolve(v);
        return existsSync(resolved) ? undefined : "Path does not exist";
      },
    });
    if (p.isCancel(entered)) { p.cancel("Setup cancelled."); return; }
    userRoots = [resolve(entered as string)];
  }

  const spinner2 = p.spinner();
  spinner2.start("Discovering git repos...");
  const { repos, hitLimit } = await discoverRepos({ extraRoots: userRoots });
  spinner2.stop(
    hitLimit
      ? `Found ${repos.length} repo(s) (scan stopped: hit ${hitLimit} limit)`
      : `Found ${repos.length} repo(s)`
  );

  const newRepos = repos.filter((r) => !r.alreadyRegistered);
  const repoOptions = newRepos.map((r) => ({
    value: r.path,
    label: basename(r.path),
    hint: `${r.path}${r.primaryLanguage ? ` · ${r.primaryLanguage}` : ""}`,
  }));

  if (repoOptions.length === 0 && existingRoots.size > 0) {
    p.log.info(`All discovered repos are already registered (${existingRoots.size} existing).`);
  }

  let selectedPaths: string[] = [];

  if (repoOptions.length > 0) {
    const selected = await p.multiselect({
      message: "Choose repos — Select repos to register (ESC or Space to skip)",
      options: [
        ...repoOptions,
        { value: "__skip_selection", label: "Skip — don't register any repo now" },
      ],
      required: false,
    });
    if (!p.isCancel(selected)) {
      selectedPaths = (selected as string[]).filter((v) => v !== "__skip_selection");
    }
  }

  const addManual = rootChoice !== "__skip" && await p.confirm({
    message: "Add a repo by path manually?",
    initialValue: false,
  });
  if (p.isCancel(addManual)) { p.cancel("Setup cancelled."); return; }
  if (addManual) {
    const manualPath = await p.text({
      message: "Absolute path to git repo",
      validate: (v) => {
        if (!v) return "Path required";
        if (!existsSync(v!)) return "Path does not exist";
        if (!existsSync(join(v!, ".git"))) return "Not a git repository";
        return undefined;
      },
    });
    if (p.isCancel(manualPath)) { p.cancel("Setup cancelled."); return; }
    selectedPaths.push(manualPath as string);
  }

  if (selectedPaths.length === 0 && existingRoots.size === 0) {
    p.log.warn("No repos selected. Run `scrybe project add` to register repos manually.");
  }

  // ── Step 3: Register repos + gen .scrybeignore ────────────────────────────
  const registeredNow: string[] = [];
  for (const repoPath of selectedPaths) {
    const projectId = basename(repoPath).toLowerCase().replace(/[^a-z0-9-]/g, "-");
    const { language } = (await import("./language-sniff.js")).sniffLanguage(repoPath, 500);

    addProject({ id: projectId, description: "" });
    addSource(projectId, {
      source_id: "primary",
      source_config: {
        type: "code",
        root_path: repoPath,
        languages: language && language !== "mixed" ? [language] : [],
      },
    });

    const result = generateScrybeIgnore(repoPath);
    if (result.wasGenerated) {
      writeFileSync(join(repoPath, ".scrybeignore"), result.content, "utf8");
      p.log.success(`Registered '${projectId}' + generated .scrybeignore`);
    } else {
      p.log.success(`Registered '${projectId}' (existing .scrybeignore preserved)`);
    }
    registeredNow.push(projectId);
  }

  // ── Step 4: MCP auto-registration ─────────────────────────────────────────
  const proposed = proposeScrybeEntry({ binResolution: "npx" });
  const mcpConfigs = detectMcpConfigs();
  const mcpDiffs = mcpConfigs.map((file) => computeDiff(file, proposed));
  const mcpToApply = mcpDiffs.filter((d) => d.action !== "skip");

  const CLIENT_NAMES: Record<string, string> = {
    "claude-code": "Claude Code",
    "cursor": "Cursor",
    "codex": "Codex",
    "cline": "Cline",
    "roo-code": "Roo Code",
  };

  let appliedCount = 0;
  if (mcpToApply.length === 0) {
    p.log.info("MCP config — all clients already configured");
  } else {
    p.log.message(`MCP config — ${mcpToApply.length} client(s) to update`);
    for (const diff of mcpToApply) {
      const clientName = CLIENT_NAMES[diff.file.type] ?? diff.file.type;
      p.log.info(`${clientName}: ${diff.action}\n${diff.diff}`);
      const confirm = await p.confirm({
        message: `Apply ${diff.action} to ${diff.file.path}?`,
        initialValue: false,
      });
      if (p.isCancel(confirm)) { p.cancel("Setup cancelled."); return; }
      if (confirm) {
        await applyMcpMerge(diff);
        p.log.success(`${clientName} updated`);
        appliedCount++;
      }
    }
    if (appliedCount === 0) {
      p.log.info("MCP config: nothing applied. Run 'scrybe init' again to add MCP entries later.");
    }
  }

  if (appliedCount > 0) {
    p.log.warn("Restart your agent (Claude Code, Cursor, etc.) to pick up the new MCP config.");
  }

  // ── Step 4.5: Always-on daemon prompt ─────────────────────────────────────
  const { isContainer } = await import("../daemon/container-detect.js");
  if (isContainer()) {
    p.log.info("Containerized environment — always-on mode skipped (daemon runs on-demand when an agent uses scrybe).");
  } else {
    const { getInstallStatus } = await import("../daemon/install/index.js");
    const installStatus = await getInstallStatus();
    const alreadyAlwaysOn = installStatus.installed;

    if (alreadyAlwaysOn) {
      const keepAlwaysOn = await p.confirm({
        message: `Always-on currently enabled (${installStatus.method ?? "autostart"}). Keep it? (No = switch to on-demand)`,
        initialValue: true,
      });
      if (p.isCancel(keepAlwaysOn)) { p.cancel("Setup cancelled."); return; }
      if (!keepAlwaysOn) {
        const spin = p.spinner();
        spin.start("Disabling always-on...");
        try {
          const { uninstallAutostart } = await import("../daemon/install/index.js");
          await uninstallAutostart();
          spin.stop("Always-on disabled. Daemon will run on-demand while an agent uses scrybe.");
        } catch (err: any) {
          spin.stop(`Could not disable: ${err?.message ?? String(err)}`);
        }
      }
    } else {
      p.log.message(
        "Background daemon — keep your index in sync automatically.\n\n" +
        "  The daemon runs while your agent is using scrybe and stops ~10 min after you\n" +
        "  close the agent. Files you change are re-indexed in the background.\n"
      );
      const alwaysOn = await p.confirm({
        message: "Keep scrybe running even when no agent is open? (useful for git pull, overnight ticket polling)",
        initialValue: false,
      });
      if (p.isCancel(alwaysOn)) { p.cancel("Setup cancelled."); return; }

      if (alwaysOn) {
        const spin = p.spinner();
        spin.start("Registering autostart...");
        try {
          const { installAutostart } = await import("../daemon/install/index.js");
          const status = await installAutostart();
          const { spawnDaemonDetached } = await import("../daemon/spawn-detached.js");
          spawnDaemonDetached({});
          await new Promise((r) => setTimeout(r, 1200));
          const { readPidfile } = await import("../daemon/pidfile.js");
          const pidData = readPidfile();
          const pidStr = pidData ? `PID ${pidData.pid} · port ${pidData.port}` : "starting";
          spin.stop(`Always-on enabled · ${status.method ?? "autostart"} · daemon started · ${pidStr}`);
        } catch (err: any) {
          spin.stop(
            `Could not register autostart: ${err?.message ?? String(err)}\n` +
            "  Continuing. Run `scrybe daemon install` later or use on-demand mode only."
          );
        }
      } else {
        p.log.info("Always-on declined. Daemon runs on-demand while an agent uses scrybe.");
      }
    }
  }

  // ── Step 5: Initial index ─────────────────────────────────────────────────
  const toIndex = registeredNow.length > 0 ? registeredNow : [];

  if (toIndex.length === 0 || opts?.registerOnly) {
    if (toIndex.length > 0) {
      p.log.info("Skipping initial index (--register-only). Run `scrybe index --project-id <id>` when ready.");
    }
  } else {
    const doIndex = await p.confirm({
      message: `Index — Index ${toIndex.length} repo(s) now? (may take 1–5 min depending on repo size)`,
      initialValue: true,
    });
    if (p.isCancel(doIndex)) { p.cancel("Setup cancelled."); return; }

    if (doIndex) {
      const total = toIndex.length;
      const spinner3 = p.spinner();
      for (let i = 0; i < total; i++) {
        const projectId = toIndex[i]!;
        const pstate: ProgressState = {
          projectIdx: i + 1,
          projectTotal: total,
          projectId,
          filesEmbedded: 0,
          filesTotal: null,
          bytesEmbedded: 0,
          bytesTotal: null,
          chunksIndexed: 0,
          throughputBps: null,
        };
        spinner3.start(formatProgressLine(pstate));
        try {
          await indexProject(projectId, "incremental", {
            onProgress: (r) => {
              if (r.phase === "embed_start") {
                pstate.filesTotal = r.filesTotal ?? null;
                pstate.bytesTotal = r.bytesTotal ?? null;
              }
              if (r.phase === "embed_batch") {
                pstate.filesEmbedded = r.filesEmbedded ?? pstate.filesEmbedded;
                pstate.bytesEmbedded = r.bytesEmbedded ?? pstate.bytesEmbedded;
                pstate.chunksIndexed = r.chunksIndexed ?? pstate.chunksIndexed;
                if (r.batchBytes && r.batchDurationMs) {
                  pstate.throughputBps = updateThroughput(
                    pstate.throughputBps,
                    r.batchBytes,
                    r.batchDurationMs
                  );
                }
                spinner3.message(formatProgressLine(pstate));
              }
            },
          });
          spinner3.stop(`[${i + 1}/${total}] ${projectId} — ${pstate.chunksIndexed} chunks indexed`);
        } catch (err: any) {
          spinner3.stop(`[${i + 1}/${total}] ${projectId} failed: ${err?.message ?? String(err)}`);
        }
      }
    }
  }

  // ── Done ──────────────────────────────────────────────────────────────────
  const allRegistered = listProjects();
  const wizardAddedAnyProject = registeredNow.length > 0;

  let outroLines: string[];
  if (wizardAddedAnyProject) {
    outroLines = [
      `Setup complete — ${allRegistered.length} project${allRegistered.length === 1 ? "" : "s"} registered.`,
      "",
      "Next: restart your agent (Claude Code, Cursor, etc.), then ask it:",
      `  "How does <topic> work in ${allRegistered[0]?.id ?? "<project>"}?"`,
      "",
      "Your agent will call scrybe automatically on relevant queries (no slash command needed).",
      "",
      "Tip: customize per-source ignore rules with `scrybe ignore`",
      "     (private to your DATA_DIR — never committed).",
      "",
      "Troubleshoot: scrybe doctor",
    ];
  } else {
    outroLines = [
      appliedCount > 0
        ? "MCP config written. Now register a project to index:"
        : "No projects registered yet. Add one manually:",
      "",
      "  scrybe project add --id myrepo --desc \"My project\"",
      "  scrybe source add -P myrepo -S primary \\",
      "    --type code --root /absolute/path/to/repo",
      "  scrybe index -P myrepo",
      "",
      "Then restart your agent and ask it a question.",
      "",
      "Tip: customize per-source ignore rules with `scrybe ignore`",
      "     (private to your DATA_DIR — never committed).",
      "",
      "Troubleshoot: scrybe doctor",
    ];
  }
  p.outro(outroLines.join("\n"));
}
