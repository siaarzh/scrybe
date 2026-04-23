import { existsSync, writeFileSync, readFileSync, mkdirSync } from "fs";
import { join, resolve, basename } from "path";
import { homedir } from "os";
import * as p from "@clack/prompts";

export interface WizardOptions {
  skipIndex?: boolean;
}

interface ProviderPreset {
  value: string;
  label: string;
  hint: string;
  baseUrl: string;
  model: string;
  dimensions: number;
  apiKeyEnvName: string;
}

const PROVIDERS: ProviderPreset[] = [
  {
    value: "voyage",
    label: "Voyage AI",
    hint: "free tier, code-optimized, recommended",
    baseUrl: "https://api.voyageai.com/v1",
    model: "voyage-code-3",
    dimensions: 1024,
    apiKeyEnvName: "VOYAGE_API_KEY",
  },
  {
    value: "openai",
    label: "OpenAI",
    hint: "text-embedding-3-small (1536d)",
    baseUrl: "https://api.openai.com/v1",
    model: "text-embedding-3-small",
    dimensions: 1536,
    apiKeyEnvName: "OPENAI_API_KEY",
  },
  {
    value: "mistral",
    label: "Mistral AI",
    hint: "mistral-embed (1024d)",
    baseUrl: "https://api.mistral.ai/v1",
    model: "mistral-embed",
    dimensions: 1024,
    apiKeyEnvName: "MISTRAL_API_KEY",
  },
  {
    value: "custom",
    label: "Custom / self-hosted",
    hint: "any OpenAI-compatible endpoint",
    baseUrl: "",
    model: "",
    dimensions: 0,
    apiKeyEnvName: "EMBEDDING_API_KEY",
  },
];

function writeEnvFile(dataDir: string, vars: Record<string, string>): void {
  mkdirSync(dataDir, { recursive: true });
  const envPath = join(dataDir, ".env");
  const existing: Record<string, string> = {};
  if (existsSync(envPath)) {
    for (const line of readFileSync(envPath, "utf8").split("\n")) {
      const eq = line.indexOf("=");
      if (eq > 0 && !line.startsWith("#")) {
        existing[line.slice(0, eq).trim()] = line.slice(eq + 1).trim();
      }
    }
  }
  const merged = { ...existing, ...vars };
  const content = Object.entries(merged).map(([k, v]) => `${k}=${v}`).join("\n") + "\n";
  writeFileSync(envPath, content, "utf8");
}

function isApiProviderConfigured(): boolean {
  return !!(
    process.env.EMBEDDING_API_KEY ||
    process.env.OPENAI_API_KEY ||
    process.env.EMBEDDING_BASE_URL
  );
}

function isLocalProviderConfigured(): boolean {
  return !!process.env.SCRYBE_LOCAL_EMBEDDER;
}

function isProviderConfigured(): boolean {
  return isApiProviderConfigured() || isLocalProviderConfigured();
}

export async function runWizard(opts?: WizardOptions): Promise<void> {
  const { config } = await import("../config.js");
  const { listProjects, addProject } = await import("../registry.js");
  const { addSource } = await import("../registry.js");
  const { validateProvider, validateLocal } = await import("./validate-provider.js");
  const { discoverRepos } = await import("./repo-discovery.js");
  const { generateScrybeIgnore } = await import("./scrybeignore.js");
  const { detectMcpConfigs, proposeScrybeEntry, computeDiff, applyMcpMerge } = await import("./mcp-config.js");
  const { indexProject } = await import("../indexer.js");

  p.intro("Scrybe setup wizard");

  // ── Step 1: Provider ───────────────────────────────────────────────────────
  const { LOCAL_PROVIDER_DEFAULTS } = await import("../providers.js");
  const LOCAL_MODEL_ID = process.env.SCRYBE_LOCAL_EMBEDDER ?? LOCAL_PROVIDER_DEFAULTS.model;

  if (isApiProviderConfigured()) {
    p.log.info(`Step 1/5 — Provider already configured: ${config.embeddingBaseUrl ?? "OpenAI (default)"} / ${config.embeddingModel}`);
  } else if (isLocalProviderConfigured()) {
    p.log.info(`Step 1/5 — Local embedder already configured: ${LOCAL_MODEL_ID}`);
  } else {
    // Default path: local embedder, no API key required.
    // "Use an external provider" escape via one keystroke.
    const useExternal = await p.confirm({
      message: "Step 1/5 — Use an external embedding provider? (Voyage AI, OpenAI, Mistral)\n" +
        "  No = local offline model (no API key, no signup — recommended for most users)",
      initialValue: false,
    });
    if (p.isCancel(useExternal)) { p.cancel("Setup cancelled."); return; }

    if (!useExternal) {
      // ── Local default path ──────────────────────────────────────────────
      const spinner = p.spinner();
      spinner.start(`Loading local embedder (${LOCAL_MODEL_ID}) — first run downloads ~120 MB...`);
      const localResult = await validateLocal(LOCAL_MODEL_ID);
      if (!localResult.ok) {
        spinner.stop(`Local embedder validation failed: ${localResult.message}`);
        p.cancel("Cannot initialise local embedder. Check your network connection and try again.");
        return;
      }
      const validatedDimsLocal = localResult.dimensions ?? LOCAL_PROVIDER_DEFAULTS.dimensions;
      spinner.stop(
        `Local embedder ready — ${validatedDimsLocal}d, cold-start ${localResult.coldStartMs ?? "?"}ms`
      );

      writeEnvFile(config.dataDir, {
        SCRYBE_LOCAL_EMBEDDER: LOCAL_MODEL_ID,
        EMBEDDING_DIMENSIONS: String(validatedDimsLocal),
      });
      p.log.success(`Local embedder config saved to ${config.dataDir}/.env`);
    } else {
      // ── External provider path (existing logic) ─────────────────────────
      const providerValue = await p.select({
        message: "Choose an embedding provider",
        options: PROVIDERS.map(({ value, label, hint }) => ({ value, label, hint })),
        initialValue: "voyage",
      });
      if (p.isCancel(providerValue)) { p.cancel("Setup cancelled."); return; }

      const providerPreset = PROVIDERS.find((pr) => pr.value === providerValue as string)!;

      let baseUrl = providerPreset.baseUrl;
      let model = providerPreset.model;
      let dimensions = providerPreset.dimensions;

      if (providerPreset.value === "custom") {
        const customUrl = await p.text({
          message: "Base URL (OpenAI-compatible, e.g. http://localhost:11434/v1)",
          validate: (v) => (v?.startsWith("http") ? undefined : "Must start with http:// or https://"),
        });
        if (p.isCancel(customUrl)) { p.cancel("Setup cancelled."); return; }
        baseUrl = customUrl as string;

        const customModel = await p.text({ message: "Model name (e.g. nomic-embed-text)" });
        if (p.isCancel(customModel)) { p.cancel("Setup cancelled."); return; }
        model = customModel as string;

        const customDims = await p.text({
          message: "Embedding dimensions (e.g. 768)",
          validate: (v) => (v && /^\d+$/.test(v) ? undefined : "Must be a number"),
        });
        if (p.isCancel(customDims)) { p.cancel("Setup cancelled."); return; }
        dimensions = parseInt(customDims as string, 10);
      }

      const keyInput = await p.password({
        message: `API key for ${providerPreset.label}`,
        validate: (v) => (v?.trim() ? undefined : "Key cannot be empty"),
      });
      if (p.isCancel(keyInput)) { p.cancel("Setup cancelled."); return; }
      const apiKey = (keyInput as string).trim();

      const spinner = p.spinner();
      spinner.start("Validating API key...");
      const result = await validateProvider({ baseUrl, model, apiKey });
      if (!result.ok) {
        spinner.stop(`Validation failed: ${result.message}`);
        p.cancel(`Could not reach ${baseUrl}. Check your key and try again.`);
        return;
      }
      const validatedDims = result.dimensions ?? dimensions;
      spinner.stop(`API key valid — model ${result.model}, ${validatedDims}d`);

      // Only Voyage supports rerank — wizard never offers rerank for other providers
      writeEnvFile(config.dataDir, {
        EMBEDDING_BASE_URL: baseUrl,
        EMBEDDING_MODEL: model,
        EMBEDDING_DIMENSIONS: String(validatedDims),
        EMBEDDING_API_KEY: apiKey,
      });
      p.log.success(`Credentials saved to ${config.dataDir}/.env`);
    }
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

  const spinner2 = p.spinner();
  spinner2.start("Discovering git repos...");
  const { repos, hitLimit } = await discoverRepos();
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
      message: "Step 2/5 — Select repos to index",
      options: repoOptions,
      required: false,
    });
    if (p.isCancel(selected)) { p.cancel("Setup cancelled."); return; }
    selectedPaths = selected as string[];
  }

  // Manual add
  const addManual = await p.confirm({
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
    p.log.warn("No repos selected. Run `scrybe add-project` to register repos manually.");
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

  if (mcpToApply.length === 0) {
    p.log.info("Step 3/5 — MCP config: all clients already configured");
  } else {
    p.log.message(`Step 3/5 — MCP configuration (${mcpToApply.length} client(s) to update)`);
    for (const diff of mcpToApply) {
      const clientName = diff.file.type === "claude-code" ? "Claude Code" : "Cursor";
      p.log.info(`${clientName}: ${diff.action}\n${diff.diff}`);
      const confirm = await p.confirm({
        message: `Apply ${diff.action} to ${diff.file.path}?`,
        initialValue: true,
      });
      if (p.isCancel(confirm)) { p.cancel("Setup cancelled."); return; }
      if (confirm) {
        await applyMcpMerge(diff);
        p.log.success(`${clientName} updated`);
      }
    }
  }

  // ── Step 5: Initial index ──────────────────────────────────────────────────
  const allProjects = listProjects();
  const toIndex = registeredNow.length > 0 ? registeredNow : [];

  if (toIndex.length === 0 || opts?.skipIndex) {
    if (toIndex.length > 0) {
      p.log.info("Skipping initial index (--skip-index). Run `scrybe index --project-id <id>` when ready.");
    }
  } else {
    const doIndex = await p.confirm({
      message: `Step 4/5 — Index ${toIndex.length} repo(s) now? (may take 1–5 min depending on repo size)`,
      initialValue: true,
    });
    if (p.isCancel(doIndex)) { p.cancel("Setup cancelled."); return; }

    if (doIndex) {
      for (const projectId of toIndex) {
        const spinner3 = p.spinner();
        spinner3.start(`Indexing '${projectId}'...`);
        try {
          const results = await indexProject(projectId, "incremental");
          const total = results.reduce((s, r) => s + r.chunks_indexed, 0);
          spinner3.stop(`'${projectId}' — ${total} chunks indexed`);
        } catch (err: any) {
          spinner3.stop(`'${projectId}' failed: ${err?.message ?? String(err)}`);
        }
      }
    }
  }

  // ── Done ───────────────────────────────────────────────────────────────────
  const allRegistered = listProjects();
  p.outro(
    [
      `Setup complete! ${allRegistered.length} project(s) registered.`,
      "",
      "Try it:",
      `  scrybe search --project-id ${allRegistered[0]?.id ?? "<id>"} "your query"`,
      "",
      "Restart your editor to pick up the MCP config.",
      "",
      "Need help? `scrybe doctor` checks your setup.",
    ].join("\n")
  );
}
