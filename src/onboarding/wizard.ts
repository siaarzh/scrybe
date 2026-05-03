import { existsSync, writeFileSync, readFileSync, mkdirSync } from "fs";
import { join, resolve, basename } from "path";
import * as p from "@clack/prompts";
import { formatProgressLine, updateThroughput } from "./progress-renderer.js";
import type { ProgressState } from "./progress-renderer.js";

export interface WizardOptions {
  registerOnly?: boolean;
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
    apiKeyEnvName: "SCRYBE_CODE_EMBEDDING_API_KEY",
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
    process.env.SCRYBE_CODE_EMBEDDING_API_KEY ||
    process.env.SCRYBE_CODE_EMBEDDING_BASE_URL
  );
}

function isLocalProviderConfigured(): boolean {
  return !!process.env.SCRYBE_LOCAL_EMBEDDER;
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
    p.log.info(`Provider — already configured: ${config.embeddingBaseUrl ?? "OpenAI (default)"} / ${config.embeddingModel}`);
  } else if (isLocalProviderConfigured()) {
    p.log.info(`Provider — local embedder already configured: ${LOCAL_MODEL_ID}`);
  } else {
    // Default path: local embedder, no API key required.
    // "Use an external provider" escape via one keystroke.
    const useExternal = await p.confirm({
      message: "Provider — Use an external embedding provider? (Voyage AI, OpenAI, Mistral)\n" +
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
        SCRYBE_CODE_EMBEDDING_DIMENSIONS: String(validatedDimsLocal),
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
        SCRYBE_CODE_EMBEDDING_BASE_URL: baseUrl,
        SCRYBE_CODE_EMBEDDING_MODEL: model,
        SCRYBE_CODE_EMBEDDING_DIMENSIONS: String(validatedDims),
        SCRYBE_CODE_EMBEDDING_API_KEY: apiKey,
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

  // Ask the user where their repos live — VS Code recents auto-detected when available.
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
    // W8: ESC → treat as skip, continue wizard
    if (!p.isCancel(selected)) {
      selectedPaths = (selected as string[]).filter((v) => v !== "__skip_selection");
    }
  }

  // W1: Only ask manual-add if user didn't explicitly skip
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

  // W4: per-client name map
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
        initialValue: false, // W2: default No — user must opt-in
      });
      if (p.isCancel(confirm)) { p.cancel("Setup cancelled."); return; }
      if (confirm) {
        await applyMcpMerge(diff);
        p.log.success(`${clientName} updated`);
        appliedCount++;
      }
    }
    // W3: accurate outro depending on whether anything was actually applied
    if (appliedCount === 0) {
      p.log.info("MCP config: nothing applied. Run 'scrybe init' again to add MCP entries later.");
    }
  }

  // W5: only warn about restart if something was applied; W6: reword to "agent"
  if (appliedCount > 0) {
    p.log.warn("Restart your agent (Claude Code, Cursor, etc.) to pick up the new MCP config.");
  }

  // ── Step 4.5: Always-on daemon prompt ─────────────────────────────────────
  const { isContainer } = await import("../daemon/container-detect.js");
  if (isContainer()) {
    p.log.info("Containerized environment — always-on mode skipped (daemon runs on-demand when an agent uses scrybe).");
  } else {
    // W7: check if autostart is already registered
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

  // ── Step 5: Initial index ──────────────────────────────────────────────────
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

  // ── Done ───────────────────────────────────────────────────────────────────
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
