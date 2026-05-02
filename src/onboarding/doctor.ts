import { existsSync, accessSync, statSync, readdirSync, constants, readFileSync } from "fs";
import { join } from "path";
import { platform } from "os";
import { execSync } from "child_process";

export type CheckStatus = "ok" | "warn" | "fail" | "skip";

export interface CheckResult {
  id: string;
  section: string;
  title: string;
  status: CheckStatus;
  message: string;
  remedy?: string;
  data?: Record<string, unknown>;
}

export interface DoctorReport {
  schemaVersion: 1;
  generatedAt: string;
  scrybeVersion: string;
  platform: string;
  checks: CheckResult[];
  summary: { ok: number; warn: number; fail: number; skip: number };
}

function ok(id: string, section: string, title: string, message: string, data?: Record<string, unknown>): CheckResult {
  return { id, section, title, status: "ok", message, data };
}
function warn(id: string, section: string, title: string, message: string, remedy?: string, data?: Record<string, unknown>): CheckResult {
  return { id, section, title, status: "warn", message, remedy, data };
}
function fail(id: string, section: string, title: string, message: string, remedy?: string, data?: Record<string, unknown>): CheckResult {
  return { id, section, title, status: "fail", message, remedy, data };
}
function skip(id: string, section: string, title: string, message: string): CheckResult {
  return { id, section, title, status: "skip", message };
}

function dirSize(dir: string): number {
  let total = 0;
  try {
    for (const entry of readdirSync(dir, { recursive: true } as any)) {
      try { total += statSync(join(dir, entry as string)).size; } catch { /* skip */ }
    }
  } catch { /* unreadable */ }
  return total;
}

function fmtBytes(b: number): string {
  if (b < 1024) return `${b} B`;
  if (b < 1024 * 1024) return `${(b / 1024).toFixed(1)} KB`;
  if (b < 1024 * 1024 * 1024) return `${(b / 1024 / 1024).toFixed(1)} MB`;
  return `${(b / 1024 / 1024 / 1024).toFixed(2)} GB`;
}

function nodeVersionOk(): boolean {
  const [major, minor] = process.versions.node.split(".").map(Number);
  return (major! > 22) || (major! === 22 && minor! >= 5);
}

export async function runDoctor(): Promise<DoctorReport> {
  // Lazy imports — doctor.ts must not force-load heavy modules at module parse time
  const { config, VERSION } = await import("../config.js");
  const { listProjects } = await import("../registry.js");
  const { readPidfile, isDaemonRunning } = await import("../daemon/pidfile.js");
  const { CURRENT_SCHEMA_VERSION } = await import("../schema-version.js");
  const { validateProvider, validateLocal } = await import("./validate-provider.js");
  const { detectMcpConfigs, readScrybeEntry, proposeScrybeEntry } = await import("./mcp-config.js");

  const checks: CheckResult[] = [];

  // ── 1. Environment ──────────────────────────────────────────────────────────
  const SEC_ENV = "Environment";

  const dataDir = config.dataDir;
  if (!existsSync(dataDir)) {
    checks.push(fail("env.data_dir", SEC_ENV, "DATA_DIR exists", `Missing: ${dataDir}`,
      `Run any scrybe command to initialise the data directory.`));
  } else {
    let writable = false;
    try { accessSync(dataDir, constants.W_OK); writable = true; } catch { /* */ }
    if (!writable) {
      checks.push(fail("env.data_dir", SEC_ENV, "DATA_DIR writable", `Not writable: ${dataDir}`,
        `Check file system permissions on ${dataDir}`));
    } else {
      const size = fmtBytes(dirSize(dataDir));
      checks.push(ok("env.data_dir", SEC_ENV, "DATA_DIR", `${dataDir} (${size})`, { path: dataDir, size }));
    }
  }

  if (!nodeVersionOk()) {
    checks.push(fail("env.node_version", SEC_ENV, "Node version",
      `Node ${process.versions.node} — need ≥ 22.5.0`,
      `Upgrade Node.js: https://nodejs.org`));
  } else {
    checks.push(ok("env.node_version", SEC_ENV, "Node version", `v${process.versions.node} (≥ 22.5.0)`));
  }

  checks.push(ok("env.scrybe_version", SEC_ENV, "Scrybe version", `v${VERSION}`));

  // ── 2. Embedding Provider ───────────────────────────────────────────────────
  const SEC_PROV = "Embedding Provider";

  if (config.embeddingConfigError) {
    checks.push(fail("provider.config", SEC_PROV, "Provider config", config.embeddingConfigError,
      "Set SCRYBE_CODE_EMBEDDING_BASE_URL, SCRYBE_CODE_EMBEDDING_MODEL, and SCRYBE_CODE_EMBEDDING_DIMENSIONS in your .env"));
    checks.push(skip("provider.key_present", SEC_PROV, "API key", "Skipped: provider config error"));
    checks.push(skip("provider.auth", SEC_PROV, "Auth", "Skipped: provider config error"));
    checks.push(skip("provider.dimensions_match", SEC_PROV, "Dimensions", "Skipped: provider config error"));
  } else if (config.embeddingProviderType === "local") {
    // ── Local WASM provider — no API key needed ─────────────────────────────
    const localModelId = config.embeddingModel;
    checks.push(ok("provider.config", SEC_PROV, "Provider config",
      `Local (offline) / ${localModelId} / ${config.embeddingDimensions}d`,
      { model: localModelId, dimensions: config.embeddingDimensions, provider_type: "local" }));
    checks.push(ok("provider.key_present", SEC_PROV, "API key", "Local embedder — no API key needed"));

    const localResult = await validateLocal(localModelId);
    if (!localResult.ok) {
      checks.push(fail("provider.auth", SEC_PROV, "Auth",
        localResult.message ?? "Local embedder failed to load",
        "Run `scrybe init` or set SCRYBE_LOCAL_EMBEDDER to a cached model ID"));
      checks.push(skip("provider.dimensions_match", SEC_PROV, "Dimensions", "Skipped: local embedder not ready"));
    } else {
      const coldMs = localResult.coldStartMs !== undefined ? ` (cold-start ${localResult.coldStartMs}ms)` : "";
      checks.push(ok("provider.auth", SEC_PROV, "Auth",
        `Local embedder loaded${coldMs}`, { dimensions: localResult.dimensions, coldStartMs: localResult.coldStartMs }));

      const actualDims = localResult.dimensions!;
      if (actualDims !== config.embeddingDimensions) {
        checks.push(fail("provider.dimensions_match", SEC_PROV, "Dimensions",
          `Config expects ${config.embeddingDimensions}d but local model returns ${actualDims}d`,
          `Set SCRYBE_CODE_EMBEDDING_DIMENSIONS=${actualDims} in your .env`));
      } else {
        checks.push(ok("provider.dimensions_match", SEC_PROV, "Dimensions", `${actualDims}d — matches config`));
      }
    }
  } else {
    // ── API provider — existing logic ───────────────────────────────────────
    const provName = config.embeddingBaseUrl ?? "OpenAI (default)";
    checks.push(ok("provider.config", SEC_PROV, "Provider config",
      `${provName} / ${config.embeddingModel} / ${config.embeddingDimensions}d`,
      { baseUrl: config.embeddingBaseUrl, model: config.embeddingModel, dimensions: config.embeddingDimensions }));

    const keyPresent = !!config.embeddingApiKey;
    if (!keyPresent) {
      checks.push(fail("provider.key_present", SEC_PROV, "API key present",
        "SCRYBE_CODE_EMBEDDING_API_KEY not set",
        "Set SCRYBE_CODE_EMBEDDING_API_KEY in your .env file"));
      checks.push(skip("provider.auth", SEC_PROV, "Auth", "Skipped: no API key"));
      checks.push(skip("provider.dimensions_match", SEC_PROV, "Dimensions", "Skipped: no API key"));
    } else {
      checks.push(ok("provider.key_present", SEC_PROV, "API key present", "Set"));

      const validateResult = await validateProvider({
        baseUrl: config.embeddingBaseUrl ?? "https://api.openai.com/v1",
        model: config.embeddingModel,
        apiKey: config.embeddingApiKey,
      });

      if (!validateResult.ok) {
        checks.push(fail("provider.auth", SEC_PROV, "Auth",
          validateResult.message ?? `Error: ${validateResult.errorType}`,
          validateResult.errorType === "auth"
            ? "Regenerate your API key and update SCRYBE_CODE_EMBEDDING_API_KEY in .env"
            : validateResult.errorType === "dns"
              ? "Check network connectivity and SCRYBE_CODE_EMBEDDING_BASE_URL"
              : validateResult.message));
        checks.push(skip("provider.dimensions_match", SEC_PROV, "Dimensions", "Skipped: auth failed"));
      } else {
        checks.push(ok("provider.auth", SEC_PROV, "Auth", `OK (${validateResult.model})`,
          { dimensions: validateResult.dimensions }));

        const actualDims = validateResult.dimensions!;
        if (actualDims !== config.embeddingDimensions) {
          checks.push(fail("provider.dimensions_match", SEC_PROV, "Dimensions",
            `Config expects ${config.embeddingDimensions}d but provider returns ${actualDims}d`,
            `Set SCRYBE_CODE_EMBEDDING_DIMENSIONS=${actualDims} in your .env`));
        } else {
          checks.push(ok("provider.dimensions_match", SEC_PROV, "Dimensions", `${actualDims}d — matches config`));
        }
      }
    }
  }

  // ── 3. Data integrity ────────────────────────────────────────────────────────
  const SEC_DATA = "Data Integrity";

  // Fresh install: projects registered but index never ran (schema.json absent).
  // Suppress expected-empty warnings for these checks so `scrybe doctor` is green post-init.
  const isFreshInstall =
    existsSync(dataDir) &&
    existsSync(join(dataDir, "projects.json")) &&
    !existsSync(join(dataDir, "schema.json"));

  const schemaPath = join(dataDir, "schema.json");
  if (!existsSync(dataDir)) {
    checks.push(skip("data.schema_version", SEC_DATA, "Schema version", "Skipped: DATA_DIR missing"));
    checks.push(skip("data.projects_json", SEC_DATA, "projects.json", "Skipped: DATA_DIR missing"));
    checks.push(skip("data.lancedb", SEC_DATA, "LanceDB", "Skipped: DATA_DIR missing"));
    checks.push(skip("data.branch_tags_db", SEC_DATA, "branch-tags.db", "Skipped: DATA_DIR missing"));
  } else {
    if (!existsSync(schemaPath)) {
      if (isFreshInstall) {
        checks.push(ok("data.schema_version", SEC_DATA, "Schema version",
          "Will be created on first index (expected)"));
      } else {
        checks.push(warn("data.schema_version", SEC_DATA, "Schema version",
          "schema.json not found — first index has not run yet",
          "Run `scrybe index --project-id <id>` after adding a project"));
      }
    } else {
      let version = 0;
      try {
        version = (JSON.parse(readFileSync(schemaPath, "utf8")) as any)?.version ?? 0;
      } catch { /* */ }
      if (version < CURRENT_SCHEMA_VERSION) {
        checks.push(warn("data.schema_version", SEC_DATA, "Schema version",
          `v${version} (current: v${CURRENT_SCHEMA_VERSION}) — migration needed`,
          "Run any index command to auto-migrate"));
      } else {
        checks.push(ok("data.schema_version", SEC_DATA, "Schema version", `v${version}`));
      }
    }

    const projectsPath = join(dataDir, "projects.json");
    if (!existsSync(projectsPath)) {
      checks.push(warn("data.projects_json", SEC_DATA, "projects.json",
        "Not found — no projects registered yet",
        "Run `scrybe init` or `scrybe add-project`"));
    } else {
      try {
        const raw = JSON.parse(readFileSync(projectsPath, "utf8"));
        if (!Array.isArray(raw)) throw new Error("not an array");
        checks.push(ok("data.projects_json", SEC_DATA, "projects.json",
          `${raw.length} project(s) registered`, { count: raw.length }));
      } catch (e: any) {
        checks.push(fail("data.projects_json", SEC_DATA, "projects.json",
          `Corrupt: ${e?.message ?? String(e)}`,
          `Back up and delete ${projectsPath}, then re-register your projects`));
      }
    }

    const lancedbDir = join(dataDir, "lancedb");
    if (!existsSync(lancedbDir)) {
      if (isFreshInstall) {
        checks.push(ok("data.lancedb", SEC_DATA, "LanceDB directory",
          "Will be created on first index (expected)"));
      } else {
        checks.push(warn("data.lancedb", SEC_DATA, "LanceDB directory",
          "Not found — no indexes created yet",
          "Run `scrybe index` after adding a project"));
      }
    } else {
      const tables = readdirSync(lancedbDir).filter((f) => f.endsWith(".lance") || existsSync(join(lancedbDir, f, "_latest.manifest")));
      checks.push(ok("data.lancedb", SEC_DATA, "LanceDB directory",
        `${tables.length} table(s)`, { tables }));
    }

    const branchTagsPath = join(dataDir, "branch-tags.db");
    if (!existsSync(branchTagsPath)) {
      if (isFreshInstall) {
        checks.push(ok("data.branch_tags_db", SEC_DATA, "branch-tags.db",
          "Will be created on first index (expected)"));
      } else {
        checks.push(warn("data.branch_tags_db", SEC_DATA, "branch-tags.db",
          "Not found — will be created on next index",
          "Run `scrybe index` after adding a code source"));
      }
    } else {
      checks.push(ok("data.branch_tags_db", SEC_DATA, "branch-tags.db", "Present"));
    }
  }

  // ── 4. Registered projects ──────────────────────────────────────────────────
  let projects: Awaited<ReturnType<typeof listProjects>> = [];
  try { projects = listProjects(); } catch { /* DATA_DIR missing — already reported */ }

  if (projects.length === 0 && existsSync(join(dataDir, "projects.json"))) {
    // projects.json exists but parsed to empty array
    // Already reported in data integrity — skip per-project checks
  }

  for (const project of projects) {
    const SEC_PROJ = `Project: ${project.id}`;

    if (project.sources.length === 0) {
      checks.push(warn(`project.${project.id}.sources`, SEC_PROJ, "Sources",
        "No sources registered",
        `Run: scrybe add-source --project-id ${project.id} --source-id primary --type code --root /path/to/repo`));
      continue;
    }

    for (const source of project.sources) {
      const sid = source.source_id;
      const lastIndexed = source.last_indexed;
      if (!lastIndexed) {
        if (isFreshInstall) {
          checks.push(ok(`project.${project.id}.${sid}.last_indexed`,
            SEC_PROJ, `${sid} — last indexed`, "Not yet indexed (expected on fresh install)"));
        } else {
          checks.push(warn(`project.${project.id}.${sid}.last_indexed`,
            SEC_PROJ, `${sid} — last indexed`, "Never indexed",
            `Run: scrybe index --project-id ${project.id} --source-ids ${sid} --incremental`));
        }
      } else {
        const age = Date.now() - new Date(lastIndexed).getTime();
        const ageDays = Math.floor(age / 86_400_000);
        if (ageDays > 30) {
          checks.push(warn(`project.${project.id}.${sid}.last_indexed`,
            SEC_PROJ, `${sid} — last indexed`, `${ageDays} days ago (${lastIndexed})`,
            `Run incremental reindex: scrybe index --project-id ${project.id} --source-ids ${sid} --incremental`));
        } else {
          checks.push(ok(`project.${project.id}.${sid}.last_indexed`,
            SEC_PROJ, `${sid} — last indexed`, lastIndexed));
        }
      }

      // Chunk count check (only for sources with a table)
      if (source.table_name) {
        try {
          // D2: use countTableRows (same counter as `scrybe ps`) to avoid discrepancy
          const { countTableRows } = await import("../vector-store.js");
          const count = await countTableRows(source.table_name);
          if (count === 0) {
            checks.push(warn(`project.${project.id}.${sid}.chunk_count`,
              SEC_PROJ, `${sid} — chunks`, "0 chunks in index",
              `Run full reindex: scrybe index --project-id ${project.id} --source-ids ${sid} --full`));
          } else {
            checks.push(ok(`project.${project.id}.${sid}.chunk_count`,
              SEC_PROJ, `${sid} — chunks`, `${count.toLocaleString()} chunks`, { count }));
          }
        } catch {
          checks.push(skip(`project.${project.id}.${sid}.chunk_count`,
            SEC_PROJ, `${sid} — chunks`, "Could not query LanceDB"));
        }
      }
    }
  }

  // ── 5. Daemon ────────────────────────────────────────────────────────────────
  const SEC_DAEMON = "Daemon";

  const pidData = readPidfile();
  if (!pidData) {
    checks.push(ok("daemon.pidfile", SEC_DAEMON, "Pidfile", "Not running (pidfile absent)"));
    checks.push(skip("daemon.http", SEC_DAEMON, "HTTP health", "Skipped: daemon not running"));
  } else {
    const { running } = await isDaemonRunning();
    if (!running) {
      checks.push(warn("daemon.pidfile", SEC_DAEMON, "Pidfile",
        `Stale pidfile (PID ${pidData.pid} is not alive)`,
        "Run `scrybe daemon start` to restart"));
      checks.push(skip("daemon.http", SEC_DAEMON, "HTTP health", "Skipped: stale pidfile"));
    } else {
      checks.push(ok("daemon.pidfile", SEC_DAEMON, "Pidfile",
        `PID ${pidData.pid} on port ${pidData.port}`, { pid: pidData.pid, port: pidData.port }));
      try {
        const res = await fetch(`http://127.0.0.1:${pidData.port}/health`, {
          signal: AbortSignal.timeout(3000),
        });
        const body = await res.json() as { ready?: boolean; version?: string };
        if (body.ready) {
          checks.push(ok("daemon.http", SEC_DAEMON, "HTTP health", `Ready (v${body.version})`));
        } else {
          checks.push(warn("daemon.http", SEC_DAEMON, "HTTP health", "Responding but not ready"));
        }
      } catch (e: any) {
        checks.push(fail("daemon.http", SEC_DAEMON, "HTTP health",
          `Unreachable: ${e?.message}`,
          `Try: scrybe daemon restart`));
      }
    }
  }

  // Always-on install status
  try {
    const { isContainer } = await import("../daemon/container-detect.js");
    if (isContainer()) {
      checks.push(skip("daemon.always_on", SEC_DAEMON, "Always-on mode",
        "Containerized environment — not applicable"));
    } else {
      const { getInstallStatus } = await import("../daemon/install/index.js");
      const installStatus = await getInstallStatus();
      if (installStatus.installed) {
        checks.push(ok("daemon.always_on", SEC_DAEMON, "Always-on mode",
          `Installed (${installStatus.method ?? "unknown"})`,
          { method: installStatus.method }));
      } else {
        checks.push(skip("daemon.always_on", SEC_DAEMON, "Always-on mode",
          "Not installed — run `scrybe daemon install` to keep the daemon running at login"));
      }
    }
  } catch {
    checks.push(skip("daemon.always_on", SEC_DAEMON, "Always-on mode", "Could not check install status"));
  }

  // Git hooks — check per code source (best-effort; skip if not a git repo)
  for (const project of projects) {
    for (const source of project.sources) {
      if (source.source_config.type !== "code") continue;
      const root = (source.source_config as any).root_path as string;
      const hooksDir = join(root, ".git", "hooks");
      if (!existsSync(hooksDir)) continue;
      const hookFile = join(hooksDir, "post-commit");
      const hasHook = existsSync(hookFile) &&
        readFileSync(hookFile, "utf8").includes("# >>> scrybe >>>");
      if (hasHook) {
        checks.push(ok(`daemon.hook.${project.id}.${source.source_id}`, SEC_DAEMON,
          `Git hooks (${project.id}/${source.source_id})`, "Installed"));
      } else {
        checks.push(warn(`daemon.hook.${project.id}.${source.source_id}`, SEC_DAEMON,
          `Git hooks (${project.id}/${source.source_id})`, "Not installed",
          `Run: scrybe hook install --project-id ${project.id} --repo ${root}`));
      }
    }
  }

  // ── 6. MCP configuration ────────────────────────────────────────────────────
  const SEC_MCP = "MCP Configuration";

  const CLIENT_NAMES: Record<string, string> = {
    "claude-code": "Claude Code", "cursor": "Cursor",
    "codex": "Codex", "cline": "Cline", "roo-code": "Roo Code",
  };
  const proposed = proposeScrybeEntry({ binResolution: "npx" });
  for (const file of detectMcpConfigs()) {
    const clientLabel = CLIENT_NAMES[file.type] ?? file.type;
    const checkId = `mcp.${file.type}`;

    if (!file.exists) {
      checks.push(warn(checkId, SEC_MCP, clientLabel,
        `${file.path} not found`,
        `Run: scrybe init  (wizard will offer to create it)`));
      continue;
    }

    const existing = readScrybeEntry(file);
    if (!existing) {
      checks.push(warn(checkId, SEC_MCP, clientLabel,
        `scrybe entry missing in ${file.path}`,
        `Run: scrybe init  (will merge the entry)`));
    } else if (JSON.stringify(existing) !== JSON.stringify(proposed)) {
      checks.push(warn(checkId, SEC_MCP, clientLabel,
        `Entry exists but differs from recommended: command="${existing.command}"`,
        `Run: scrybe init  (will offer to update)`));
    } else {
      checks.push(ok(checkId, SEC_MCP, clientLabel, "Entry present and up to date"));
    }
  }

  // ── Summary ─────────────────────────────────────────────────────────────────
  const summary = { ok: 0, warn: 0, fail: 0, skip: 0 };
  for (const c of checks) summary[c.status]++;

  return {
    schemaVersion: 1,
    generatedAt: new Date().toISOString(),
    scrybeVersion: VERSION,
    platform: `${platform()} / Node ${process.versions.node}`,
    checks,
    summary,
  };
}
