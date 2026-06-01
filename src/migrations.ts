/**
 * Migration registry — named, idempotent, non-destructive one-time migrations.
 *
 * Each entry runs once per DATA_DIR install. Applied IDs are persisted in
 * schema.json `migrations_applied`. Safe to call on every CLI/daemon start.
 *
 * Contrast with schema-version.ts (destructive version bump, forces full reindex).
 * This registry is for additive/maintenance migrations that must not wipe data.
 */
import { existsSync, readFileSync, writeFileSync, mkdirSync, renameSync, unlinkSync } from "fs";
import { join, dirname } from "path";
import { config } from "./config.js";
import { listProjects } from "./registry.js";
import {
  compactTable,
  readTableMeta,
  writeTableMeta,
  knowledgeTableMetadataUpToDate,
  makeKnowledgeSchema,
  CURRENT_KNOWLEDGE_SCHEMA_VERSION,
  CURRENT_KNOWLEDGE_SCHEMA_VERSION_INTRODUCED_IN,
} from "./vector-store.js";

export interface Migration {
  id: string;
  run(): Promise<void>;
}

/**
 * Auto-copy SCRYBE_CODE_EMBEDDING_API_KEY into SCRYBE_RERANK_API_KEY for users
 * who had SCRYBE_RERANK=true working before v0.29.0 (when the key was reused).
 *
 * Conditions: SCRYBE_RERANK=true AND SCRYBE_CODE_EMBEDDING_API_KEY is set
 * AND SCRYBE_RERANK_API_KEY is NOT yet set → append to .env.
 *
 * Fix 2 (Plan 31): restores prior rerank behaviour for upgraders.
 */
function addRerankKeyIfMissing(): void {
  const envPath = join(config.dataDir, ".env");

  // Parse .env to check current keys
  const keysPresent = new Set<string>();
  const keyValues = new Map<string, string>();
  let envContent = "";

  if (existsSync(envPath)) {
    try {
      envContent = readFileSync(envPath, "utf8");
    } catch { return; }
    for (const line of envContent.split("\n")) {
      const trimmed = line.trim();
      if (!trimmed || trimmed.startsWith("#")) continue;
      const eq = trimmed.indexOf("=");
      if (eq === -1) continue;
      const key = trimmed.slice(0, eq).trim();
      const val = trimmed.slice(eq + 1).trim();
      if (key) { keysPresent.add(key); keyValues.set(key, val); }
    }
  }

  // Check condition: SCRYBE_RERANK=true AND embedding key present AND rerank key absent
  const rerankEnabled =
    (keysPresent.has("SCRYBE_RERANK") && keyValues.get("SCRYBE_RERANK") === "true") ||
    process.env["SCRYBE_RERANK"] === "true";
  const embeddingKey =
    keyValues.get("SCRYBE_CODE_EMBEDDING_API_KEY") ??
    process.env["SCRYBE_CODE_EMBEDDING_API_KEY"] ??
    "";
  const rerankKeyAlreadySet =
    keysPresent.has("SCRYBE_RERANK_API_KEY") ||
    !!process.env["SCRYBE_RERANK_API_KEY"];

  if (!rerankEnabled || !embeddingKey || rerankKeyAlreadySet) return;

  // Append the rerank key line, preserving existing file content
  const appendLine = `SCRYBE_RERANK_API_KEY=${embeddingKey}`;
  const newContent = envContent
    ? (envContent.endsWith("\n") ? envContent + appendLine + "\n" : envContent + "\n" + appendLine + "\n")
    : appendLine + "\n";

  try {
    writeFileSync(envPath, newContent, "utf8");
    process.stderr.write(
      "[scrybe] migration: copied SCRYBE_CODE_EMBEDDING_API_KEY into SCRYBE_RERANK_API_KEY (rerank reuse compatibility)\n"
    );
    // Also set it in process.env for this run
    if (!process.env["SCRYBE_RERANK_API_KEY"]) {
      process.env["SCRYBE_RERANK_API_KEY"] = embeddingKey;
    }
  } catch (e) {
    process.stderr.write(`[scrybe] migration: could not write SCRYBE_RERANK_API_KEY to .env: ${e}\n`);
  }
}

/**
 * One-shot cleanup: find jobs for removed projects (zombies) and mark them cancelled.
 * Idempotent — subsequent runs find no matching rows.
 */
async function cancelZombieJobs(): Promise<void> {
  const { getDB } = await import("./branch-state.js");
  const db = getDB();

  const projects = listProjects();
  const validIds = new Set(projects.map((p) => p.id));

  const candidates = db.prepare(
    "SELECT job_id, project_id FROM jobs WHERE status IN ('queued', 'running')"
  ).all() as Array<{ job_id: string; project_id: string }>;

  const zombies = candidates.filter((j) => !validIds.has(j.project_id));
  if (zombies.length === 0) return;

  const now = Date.now();
  const update = db.prepare(
    "UPDATE jobs SET status='cancelled', error_message='project no longer exists (zombie cleanup)', finished_at=? WHERE job_id=?"
  );
  for (const z of zombies) {
    try { update.run(now, z.job_id); } catch { /* non-fatal */ }
  }

  const uniqueProjects = [...new Set(zombies.map((z) => z.project_id))];
  process.stderr.write(
    `[scrybe] migration: cleaned up ${zombies.length} zombie job(s) for removed project(s): ${uniqueProjects.join(", ")}\n`
  );
}

/**
 * Cold-start reconcile: any pre-boot running/queued job for a VALID (still-registered)
 * project is marked `interrupted`. Distinct from `cancelled` (removed-project case in
 * cancelZombieJobs). Reads true: the daemon was killed mid-flight; incremental reindex
 * self-heals data on the next trigger. Idempotent.
 */
async function reconcileInterruptedJobs(): Promise<void> {
  const { getDB } = await import("./branch-state.js");
  const db = getDB();

  const projects = listProjects();
  const validIds = new Set(projects.map((p) => p.id));

  const candidates = db.prepare(
    "SELECT job_id, project_id FROM jobs WHERE status IN ('queued', 'running')"
  ).all() as Array<{ job_id: string; project_id: string }>;

  // Only valid-project pre-boot jobs — removed-project jobs are handled by cancelZombieJobs.
  const preBootJobs = candidates.filter((j) => validIds.has(j.project_id));
  if (preBootJobs.length === 0) return;

  const now = Date.now();
  const update = db.prepare(
    "UPDATE jobs SET status='interrupted', error_message='interrupted by daemon restart', finished_at=? WHERE job_id=?"
  );
  for (const j of preBootJobs) {
    try { update.run(now, j.job_id); } catch { /* non-fatal */ }
  }

  process.stderr.write(
    `[scrybe] migration: marked ${preBootJobs.length} pre-boot job(s) as interrupted (daemon restart)\n`
  );
}

// ─── Plan 23 migration helpers ────────────────────────────────────────────────

/**
 * Parse KEY=VALUE lines from a .env file content string.
 * Returns a Map of key → value for all set keys.
 */
function parseEnvContent(content: string): Map<string, string> {
  const map = new Map<string, string>();
  for (const raw of content.split("\n")) {
    const trimmed = raw.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;
    const eq = trimmed.indexOf("=");
    if (eq <= 0) continue;
    const key = trimmed.slice(0, eq).trim();
    const value = trimmed.slice(eq + 1).trim();
    if (key && value) map.set(key, value);
  }
  return map;
}

/**
 * Synthesize starter presets from legacy profile-keyed env vars.
 *
 * If SCRYBE_CODE_EMBEDDING_* is set, creates `migrated-code` referencing the
 * existing var verbatim. Same for SCRYBE_KNOWLEDGE_EMBEDDING_* → `migrated-text`.
 * If neither is set, creates `local-default-code` and `local-default-text`
 * pointing at the local embedder.
 *
 * Credentials fields store `${VAR_NAME}` — the existing var name verbatim.
 * No forced rename per D5.
 */
export function synthesizeMigrationConfig(
  envVars: Map<string, string>,
  rerankEnabled: boolean,
  providers?: typeof import("./providers.js").PROVIDERS,
): import("./config.js").ScrybeConfig {
  type ScrybeConfig = import("./config.js").ScrybeConfig;
  type EmbeddingPreset = import("./config.js").EmbeddingPreset;

  const codeApiKey = envVars.get("SCRYBE_CODE_EMBEDDING_API_KEY");
  const codeBaseUrl = envVars.get("SCRYBE_CODE_EMBEDDING_BASE_URL");
  const codeModel = envVars.get("SCRYBE_CODE_EMBEDDING_MODEL");
  const codeDims = envVars.get("SCRYBE_CODE_EMBEDDING_DIMENSIONS");

  const knowledgeApiKey = envVars.get("SCRYBE_KNOWLEDGE_EMBEDDING_API_KEY");
  const knowledgeBaseUrl = envVars.get("SCRYBE_KNOWLEDGE_EMBEDDING_BASE_URL");
  const knowledgeModel = envVars.get("SCRYBE_KNOWLEDGE_EMBEDDING_MODEL");
  const knowledgeDims = envVars.get("SCRYBE_KNOWLEDGE_EMBEDDING_DIMENSIONS");

  const hasCode = !!(codeApiKey || codeBaseUrl || codeModel);
  const hasKnowledge = !!(knowledgeApiKey || knowledgeBaseUrl || knowledgeModel);

  const embeddingPresets: Record<string, EmbeddingPreset> = {};
  let codePresetName: string;
  let textPresetName: string;

  if (hasCode) {
    codePresetName = "migrated-code";
    // Determine provider from base URL if possible
    let provider = "custom";
    if (codeBaseUrl) {
      try {
        const { hostname } = new URL(codeBaseUrl);
        if (hostname === "api.voyageai.com") provider = "voyage";
        else if (hostname === "api.openai.com") provider = "openai";
        else if (hostname === "api.mistral.ai") provider = "mistral";
      } catch { /* keep custom */ }
    } else if (!codeBaseUrl && codeApiKey) {
      // API key but no URL — assume OpenAI-compatible; keep provider as legacy guess
    }

    const preset: EmbeddingPreset = {
      provider,
      model: codeModel ?? (provider === "voyage" ? "voyage-code-3" : "text-embedding-3-small"),
      credentials: "${SCRYBE_CODE_EMBEDDING_API_KEY}",
    };
    if (provider === "custom" && codeBaseUrl) preset.base_url = codeBaseUrl;
    if (codeDims) preset.dim = parseInt(codeDims, 10);
    embeddingPresets[codePresetName] = preset;
  } else {
    codePresetName = "local-default-code";
    embeddingPresets[codePresetName] = {
      provider: "local",
      model: "Xenova/multilingual-e5-small",
      prompt_template: { query: "query: ", passage: "passage: " },
      max_input_tokens: 512,
    };
  }

  if (hasKnowledge) {
    textPresetName = "migrated-text";
    let provider = "custom";
    const effectiveBaseUrl = knowledgeBaseUrl ?? codeBaseUrl;
    if (effectiveBaseUrl) {
      try {
        const { hostname } = new URL(effectiveBaseUrl);
        if (hostname === "api.voyageai.com") provider = "voyage";
        else if (hostname === "api.openai.com") provider = "openai";
        else if (hostname === "api.mistral.ai") provider = "mistral";
      } catch { /* keep custom */ }
    }

    const preset: EmbeddingPreset = {
      provider,
      model: knowledgeModel ?? (provider === "voyage" ? "voyage-4" : "text-embedding-3-small"),
      credentials: "${SCRYBE_KNOWLEDGE_EMBEDDING_API_KEY}",
    };
    if (provider === "custom" && effectiveBaseUrl) preset.base_url = effectiveBaseUrl;
    if (knowledgeDims) preset.dim = parseInt(knowledgeDims, 10);
    embeddingPresets[textPresetName] = preset;
  } else if (!hasCode) {
    // Neither set — use local defaults for both
    textPresetName = "local-default-text";
    embeddingPresets[textPresetName] = {
      provider: "local",
      model: "Xenova/multilingual-e5-small",
      prompt_template: { query: "query: ", passage: "passage: " },
      max_input_tokens: 512,
    };
  } else {
    // Code is set but knowledge is not — fall back to local default for text.
    // Reusing the code preset is wrong: code-profile models (e.g. voyage-code-3)
    // are rejected when assigned to the text_preset slot.
    textPresetName = "local-default-text";
    embeddingPresets[textPresetName] = {
      provider: "local",
      model: "Xenova/multilingual-e5-small",
      prompt_template: { query: "query: ", passage: "passage: " },
      max_input_tokens: 512,
    };
  }

  const assignments: ScrybeConfig["assignments"] = {
    code_preset: codePresetName,
    text_preset: textPresetName,
  };

  const cfg: ScrybeConfig = {
    schema_version: 1,
    embedding_presets: embeddingPresets,
    assignments,
  };

  // Synthesize rerank preset if SCRYBE_RERANK=true and the code embedding provider
  // has rerank capability.
  if (rerankEnabled && hasCode && providers) {
    const codePreset = embeddingPresets[codePresetName];
    if (codePreset) {
      const providerSpec = providers[codePreset.provider];
      const hasRerank = providerSpec?.rerank_models != null &&
        Object.keys(providerSpec.rerank_models).length > 0;
      if (hasRerank) {
        const rerankPresetName = "migrated-rerank";
        const defaultRerankModel = Object.keys(providerSpec.rerank_models!)[0]!;
        cfg.reranker_presets = {
          [rerankPresetName]: {
            // provider omitted → defaults to "http" (HTTP reranker; catalog name
            // was previously stored here but was unused at runtime)
            model: defaultRerankModel,
            credentials_from: codePresetName,
          },
        };
        assignments.rerank_preset = rerankPresetName;
      }
    }
  }

  return cfg;
}

/**
 * Main Plan 23 migration: synthesize config.json, drop per-source embedding
 * overrides, backfill sidecar model fields.
 *
 * Idempotent: if config.json already exists, skips synthesis but still walks
 * projects.json to drop overrides and backfill sidecars.
 */
async function migrateToConfigJson(): Promise<void> {
  const dataDir = config.dataDir;
  const configPath = join(dataDir, "config.json");
  const envPath = join(dataDir, ".env");

  // Step 1: parse existing .env
  let envVars = new Map<string, string>();
  if (existsSync(envPath)) {
    try {
      envVars = parseEnvContent(readFileSync(envPath, "utf8"));
    } catch { /* non-fatal — proceed with empty map */ }
  }

  const rerankEnabled =
    envVars.get("SCRYBE_RERANK") === "true" ||
    process.env["SCRYBE_RERANK"] === "true";

  // Step 2: synthesize config.json (idempotent — skip if already exists)
  if (!existsSync(configPath)) {
    const { writeScrybeConfig } = await import("./config.js");
    const { PROVIDERS } = await import("./providers.js");
    const cfg = synthesizeMigrationConfig(envVars, rerankEnabled, PROVIDERS);
    writeScrybeConfig(cfg);
    process.stderr.write(
      "[scrybe] migration: synthesized starter config.json from existing env vars. " +
      "Run 'scrybe model show' to review, or 'scrybe init' to reconfigure.\n"
    );
  }

  // Step 3: walk projects.json — drop source.embedding overrides, backfill sidecars
  const projectsPath = join(dataDir, "projects.json");
  if (!existsSync(projectsPath)) return;

  let projects: Array<Record<string, unknown>>;
  try {
    projects = JSON.parse(readFileSync(projectsPath, "utf8")) as Array<Record<string, unknown>>;
  } catch {
    return; // corrupt projects.json — skip (not safe to mutate)
  }

  let projectsChanged = false;
  const { readScrybeConfig } = await import("./config.js");
  const { resolvePreset } = await import("./preset-resolver.js");
  const cfg = readScrybeConfig();

  for (const project of projects) {
    const projectId = String(project["id"] ?? "");
    const sources = Array.isArray(project["sources"]) ? project["sources"] : [];

    for (const source of sources as Array<Record<string, unknown>>) {
      const sourceId = String(source["source_id"] ?? "");

      // Drop per-source embedding override (the field is no longer supported)
      if (source["embedding"] !== undefined) {
        delete source["embedding"];
        projectsChanged = true;
        process.stderr.write(
          `[scrybe] migration: source ${projectId}/${sourceId} had a per-source embedding ` +
          `override that's no longer supported. The current resolved preset will be used. ` +
          `Run 'scrybe model switch --source-type <code|text>' to reindex if the resolved preset differs.\n`
        );
      }

      // Backfill sidecar model fields (best-effort)
      const tableName = source["table_name"];
      if (typeof tableName !== "string" || !tableName) continue;

      const existingMeta = readTableMeta(tableName);
      // Skip if model fields are already present (previously migrated)
      if (existingMeta?.["model"] !== undefined) continue;

      // Determine source profile from source_config type
      const sourceConfigType = (source["source_config"] as Record<string, unknown>)?.["type"];
      let profile: "code" | "text" = "code";
      try {
        const { getPlugin } = await import("./plugins/index.js");
        profile = getPlugin(String(sourceConfigType ?? "code")).embeddingProfile;
      } catch { /* unknown plugin — default to code */ }

      // Try to resolve the current preset for this profile
      const modelFields: Record<string, unknown> = {
        indexed_at: new Date().toISOString(),
      };

      if (cfg !== null) {
        const slot = profile === "code" ? "code_preset" : "text_preset";
        const presetName = cfg.assignments[slot];
        if (presetName) {
          try {
            const resolved = resolvePreset(presetName, slot, cfg);
            modelFields["model"] = resolved.model;
            modelFields["dim"] = resolved.dim;
            modelFields["provider"] = resolved.provider;
            modelFields["preset_at_index_time"] = presetName;
          } catch {
            // Resolution failed (env var missing, etc.) — write fallback values
            modelFields["model"] = "<unknown>";
            modelFields["dim"] = 0;
            modelFields["provider"] = "<unknown>";
            modelFields["preset_at_index_time"] = presetName ?? "<unknown>";
            process.stderr.write(
              `[scrybe] migration: could not resolve preset for source ${projectId}/${sourceId}. ` +
              `Sidecar stamped with placeholder values. Run 'scrybe model switch --source-type ${profile}' to correct.\n`
            );
          }
        }
      } else {
        // No config.json (shouldn't happen — we just wrote it above, but be safe)
        modelFields["model"] = "<unknown>";
        modelFields["dim"] = 0;
        modelFields["provider"] = "<unknown>";
      }

      writeTableMeta(tableName, modelFields);
    }
  }

  // Persist projects.json changes (embedding overrides dropped)
  if (projectsChanged) {
    mkdirSync(dirname(projectsPath), { recursive: true });
    const tmpPath = projectsPath + ".tmp";
    writeFileSync(tmpPath, JSON.stringify(projects, null, 2), "utf8");
    try {
      renameSync(tmpPath, projectsPath);
    } catch (err: any) {
      if (err.code === "EEXIST") {
        unlinkSync(projectsPath);
        renameSync(tmpPath, projectsPath);
      } else {
        throw err;
      }
    }
  }
}

// ─── Plan 42 migration — backfill knowledge tables with metadata columns ──────
//
// Tables indexed before v0.41.0 lack the five Plan-42 metadata columns
// (state, labels, assignees, milestone, confidential). The fix is:
//   1. Read vector dimensions from the existing table's schema.
//   2. Drop and recreate the table with the current makeKnowledgeSchema() (empty).
//   3. Delete the source cursor so the next incremental fetch becomes a full
//      re-fetch (no cursor = fetch all issues from the beginning).
//   4. Wipe branch_tags rows for this source (now dangling — table is empty).
//   5. Stamp knowledge_schema_version: 2 in the sidecar.
//
// After migration the table is empty. The daemon ticket-poller (or manual
// `scrybe index --full`) will re-fetch everything and populate the new columns.
//
// Injectable dependencies allow unit-testing without touching the real LanceDB
// or branch-tags DB. The production codepath uses defaults that import lazily.

export interface KnowledgeMigrationSourceResult {
  status: "ok" | "skipped" | "failed";
  projectId: string;
  sourceId: string;
  reason?: string;
}

export async function migrateKnowledgeTablesForPlan42(opts?: {
  /** @internal — inject the LanceDB path (tests only). */
  _lanceDbPath?: string;
  /** @internal — inject projects list (tests only). */
  _projects?: Array<{ id: string; sources: Array<{ source_id: string; source_config: { type: string }; table_name?: string }> }>;
  /** @internal — inject the metadata-schema-version check (tests only). */
  _metadataUpToDate?: (tableName: string) => boolean;
  /** @internal — inject dropAndRecreate (tests only). */
  _dropAndRecreate?: (tableName: string, schema: import("apache-arrow").Schema, sidecarFields: Record<string, unknown>) => Promise<void>;
  /** @internal — inject deleteCursor (tests only). */
  _deleteCursor?: (projectId: string, sourceId: string) => void;
  /** @internal — inject wipeSource (tests only). */
  _wipeSource?: (projectId: string, sourceId: string) => void;
}): Promise<KnowledgeMigrationSourceResult[]> {
  const results: KnowledgeMigrationSourceResult[] = [];
  const projects = opts?._projects ?? listProjects();
  const metadataUpToDate = opts?._metadataUpToDate ?? knowledgeTableMetadataUpToDate;

  for (const project of projects) {
    for (const source of project.sources) {
      const sourceType = (source.source_config as { type: string }).type ?? "code";
      // Only migrate ticket (knowledge) sources.
      if (sourceType !== "ticket") continue;

      const tableName = source.table_name;
      if (!tableName) {
        // Source registered but never indexed — nothing to migrate.
        results.push({ status: "skipped", projectId: project.id, sourceId: source.source_id, reason: "no table_name (not yet indexed)" });
        continue;
      }

      // Fast sidecar-version detection — skip if already on the current schema.
      if (metadataUpToDate(tableName)) {
        results.push({ status: "skipped", projectId: project.id, sourceId: source.source_id, reason: "already at current metadata schema" });
        continue;
      }

      // Table exists but lacks metadata columns. Read dimensions from the existing
      // table schema before dropping (needed to recreate with the same vector size).
      let dimensions = 1536; // fallback default
      try {
        const lancedb = await import("@lancedb/lancedb");
        const dbPath = opts?._lanceDbPath ?? join(config.dataDir, "lancedb");
        const db = await lancedb.connect(dbPath);
        const tableNames = await db.tableNames();
        if (tableNames.includes(tableName)) {
          const t = await db.openTable(tableName);
          const schema = await t.schema();
          const vecField = schema.fields.find((f) => f.name === "vector");
          if (vecField != null) {
            const listType = vecField.type as { listSize?: number };
            if (typeof listType.listSize === "number" && listType.listSize > 0) {
              dimensions = listType.listSize;
            }
          }
        }
      } catch (err) {
        // Non-fatal: dimensions fallback to 1536; migration proceeds.
        process.stderr.write(
          `[scrybe] migration: could not read vector dimensions for ${project.id}/${source.source_id} ` +
          `(${err instanceof Error ? err.message : String(err)}); using fallback ${dimensions}\n`
        );
      }

      try {
        // Step 1: Drop and recreate with current knowledge schema (empty table).
        if (opts?._dropAndRecreate) {
          await opts._dropAndRecreate(tableName, makeKnowledgeSchema(dimensions), {
            knowledge_schema_version: CURRENT_KNOWLEDGE_SCHEMA_VERSION,
            knowledge_schema_version_introduced_in: CURRENT_KNOWLEDGE_SCHEMA_VERSION_INTRODUCED_IN,
          });
        } else {
          const { dropAndRecreateTable } = await import("./vector-store.js");
          await dropAndRecreateTable(tableName, makeKnowledgeSchema(dimensions), {
            knowledge_schema_version: CURRENT_KNOWLEDGE_SCHEMA_VERSION,
            knowledge_schema_version_introduced_in: CURRENT_KNOWLEDGE_SCHEMA_VERSION_INTRODUCED_IN,
          });
        }

        // Step 2: Delete the cursor so the next incremental fetch is a full re-fetch.
        if (opts?._deleteCursor) {
          opts._deleteCursor(project.id, source.source_id);
        } else {
          const { deleteCursor } = await import("./cursors.js");
          deleteCursor(project.id, source.source_id);
        }

        // Step 3: Wipe branch_tags rows for this source (now dangling).
        if (opts?._wipeSource) {
          opts._wipeSource(project.id, source.source_id);
        } else {
          try {
            const { wipeSource } = await import("./branch-state.js");
            wipeSource(project.id, source.source_id);
          } catch {
            // branch-tags DB may not exist on fresh installs — non-fatal.
          }
        }

        process.stderr.write(
          `[scrybe] migration: dropped and recreated knowledge table for ${project.id}/${source.source_id} ` +
          `(dimensions=${dimensions}). A full reindex will run on next daemon start or manual 'scrybe index'.\n`
        );

        results.push({ status: "ok", projectId: project.id, sourceId: source.source_id });
      } catch (err) {
        process.stderr.write(
          `[scrybe] migration: failed to migrate knowledge table ${project.id}/${source.source_id}: ` +
          `${err instanceof Error ? err.message : String(err)}\n`
        );
        results.push({
          status: "failed",
          projectId: project.id,
          sourceId: source.source_id,
          reason: err instanceof Error ? err.message : String(err),
        });
      }
    }
  }

  return results;
}

const MIGRATIONS: Migration[] = [
  {
    id: "compact-tables-v0.23.2",
    async run() {
      const projects = listProjects();
      for (const p of projects) {
        for (const s of p.sources) {
          if (!s.table_name) continue;
          process.stderr.write(`[scrybe] migrating: compacting ${p.id}/${s.source_id}...\n`);
          try {
            await compactTable(s.table_name);
          } catch {
            // Table may not exist yet (fresh install) — safe to skip
          }
        }
      }
    },
  },
  {
    // Fix 1 (Plan 31): env rename now happens eagerly in loadDotEnv() inside config.ts,
    // BEFORE buildRerankConfig() evaluates. This entry remains registered so the stamp
    // is recorded in schema.json — the run() is a no-op since the work already happened.
    id: "rename-env-vars-v0.29.0",
    async run() {
      // No-op: env rename is now performed at config.ts load time (loadDotEnv).
    },
  },
  {
    // Fix 2 (Plan 31): for users upgrading from ≤0.28.x who had SCRYBE_RERANK=true
    // working via the now-removed embedding-key reuse fallback, auto-copy the key.
    // Must run AFTER rename-env-vars-v0.29.0 so old EMBEDDING_API_KEY has been renamed
    // to SCRYBE_CODE_EMBEDDING_API_KEY before we read it.
    id: "add-rerank-key-v0.29.1",
    async run() {
      addRerankKeyIfMissing();
    },
  },
  {
    // Plan 33: Clean up zombie jobs — queued/running jobs for projects that no longer
    // exist in projects.json. These accumulate when a project is removed while jobs
    // are pending (the old removeProject didn't cancel them). Idempotent.
    id: "cleanup-zombie-jobs-v0.29.3",
    async run() {
      await cancelZombieJobs();
    },
  },
  {
    // Plan 23: Synthesize config.json from existing profile-keyed env vars.
    // Drops per-source embedding overrides from projects.json.
    // Backfills model-provenance fields into per-table sidecars (best-effort).
    id: "init-config-v0.32.0",
    async run() {
      await migrateToConfigJson();
    },
  },
  {
    // Plan 77 / Plan 70: Auto-add prompt_template to existing local-default-* e5 presets
    // that were created before this field existed. Only adds the template when ALL of:
    //   1. preset name starts with "local-default-" (user-defined presets are left alone)
    //   2. preset provider is "local"
    //   3. preset model contains "e5" (only e5-family models need these prefixes)
    //   4. prompt_template is not already set (idempotent)
    // Non-e5 local models (e.g. BGE, all-MiniLM) are NOT touched.
    id: "add-e5-prompt-template-v0.37.0",
    async run() {
      const { readScrybeConfig, writeScrybeConfig } = await import("./config.js");
      const cfg = readScrybeConfig();
      if (!cfg) return; // no config.json yet — nothing to upgrade

      let changed = false;
      for (const [name, preset] of Object.entries(cfg.embedding_presets)) {
        if (
          name.startsWith("local-default-") &&
          preset.provider === "local" &&
          /e5/i.test(preset.model) &&
          preset.prompt_template === undefined
        ) {
          cfg.embedding_presets[name] = {
            ...preset,
            prompt_template: { query: "query: ", passage: "passage: " },
          };
          changed = true;
          process.stderr.write(
            `[scrybe] migration: added prompt_template to local e5 preset "${name}" ` +
            `(model: ${preset.model}). A full reindex is recommended for local-embedder sources.\n`
          );
        }
      }

      if (changed) {
        writeScrybeConfig(cfg);
      }
    },
  },
  {
    // Plan 77: Auto-add max_input_tokens to existing local-default-* e5 presets
    // that were created before this field existed. Only adds the field when ALL of:
    //   1. preset name starts with "local-default-"
    //   2. preset provider is "local"
    //   3. preset model contains "e5" (only e5-family models need the 512-token cap)
    //   4. max_input_tokens is not already set (idempotent)
    // Non-e5 local models are NOT touched.
    id: "add-e5-max-input-tokens-v0.37.0",
    async run() {
      const { readScrybeConfig, writeScrybeConfig } = await import("./config.js");
      const cfg = readScrybeConfig();
      if (!cfg) return; // no config.json yet — nothing to upgrade

      let changed = false;
      for (const [name, preset] of Object.entries(cfg.embedding_presets)) {
        if (
          name.startsWith("local-default-") &&
          preset.provider === "local" &&
          /e5/i.test(preset.model) &&
          preset.max_input_tokens === undefined
        ) {
          cfg.embedding_presets[name] = {
            ...preset,
            max_input_tokens: 512,
          };
          changed = true;
          process.stderr.write(
            `[scrybe] migration: added max_input_tokens=512 to local e5 preset "${name}" ` +
            `(model: ${preset.model}). A full reindex is recommended for local-embedder sources.\n`
          );
        }
      }

      if (changed) {
        writeScrybeConfig(cfg);
      }
    },
  },
  {
    // On cold start, mark any pre-boot running/queued jobs for VALID projects
    // as `interrupted` (not cancelled — those remain for removed-project zombies from
    // cancelZombieJobs above). Closes the ghost-job symptom in GitHub #33.
    id: "reconcile-interrupted-jobs-v0.38.0",
    async run() {
      await reconcileInterruptedJobs();
    },
  },
  {
    // Plan 72: Auto-upgrade the text embedding preset from voyage-3 to voyage-4
    // for users who got voyage-3 as the auto-default. Users who explicitly chose
    // any model (including voyage-3) via 'scrybe model preset' are left untouched
    // by the heuristic (text_preset model === "voyage-3" exactly).
    id: "upgrade-voyage-text-default-v0.36.0",
    async run() {
      const { readScrybeConfig, writeScrybeConfig } = await import("./config.js");
      const cfg = readScrybeConfig();
      if (!cfg) return; // no config.json yet — nothing to upgrade

      const textPresetName = cfg.assignments?.text_preset;
      if (!textPresetName) return;

      const textPreset = cfg.embedding_presets?.[textPresetName];
      if (!textPreset) return;

      if (textPreset.model !== "voyage-3") return;

      // Upgrade: rewrite model in place, preserve all other fields
      cfg.embedding_presets[textPresetName] = { ...textPreset, model: "voyage-4" };
      writeScrybeConfig(cfg);
      process.stderr.write(
        "[scrybe] migration: upgraded text embedding preset from voyage-3 to voyage-4. " +
        "Run 'scrybe model switch --source-type text' to reindex knowledge sources.\n"
      );
    },
  },
  {
    // Plan 42: Drop-recreate knowledge (ticket) tables that predate the five
    // metadata columns (state, labels, assignees, milestone, confidential).
    // The table is recreated empty; cursors are cleared so the next incremental
    // fetch becomes a full re-fetch. The daemon ticket-poller or a manual
    // `scrybe index` will repopulate the table with all columns stamped.
    id: "knowledge-metadata-columns-v0.41.0",
    async run() {
      await migrateKnowledgeTablesForPlan42();
    },
  },
];

/**
 * Run any migrations not yet in `appliedIds`.
 * Returns the updated list of applied IDs (caller must persist).
 */
export async function runPendingMigrations(appliedIds: string[]): Promise<string[]> {
  const applied = new Set(appliedIds);
  const result = [...appliedIds];
  for (const migration of MIGRATIONS) {
    if (applied.has(migration.id)) continue;
    await migration.run();
    result.push(migration.id);
  }
  return result;
}
