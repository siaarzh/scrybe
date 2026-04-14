import { readFileSync, writeFileSync, mkdirSync, existsSync, renameSync, unlinkSync } from "fs";
import { join, dirname } from "path";
import { createHash } from "crypto";
import { config } from "./config.js";
import { dropTable } from "./vector-store.js";
import { getPlugin } from "./plugins/index.js";
import type { Project, Source, EmbeddingConfig } from "./types.js";

const REGISTRY_PATH = join(config.dataDir, "projects.json");

// Raw shape as it may appear on disk (old flat model or new multi-source)
type RawProject = Project & {
  // Old flat-model fields (present during migration)
  root_path?: string;
  languages?: string[];
  source_config?: unknown;
  last_indexed?: string;
};

function load(): Project[] {
  if (!existsSync(REGISTRY_PATH)) return [];
  let projects: RawProject[];
  try {
    projects = JSON.parse(readFileSync(REGISTRY_PATH, "utf8")) as RawProject[];
  } catch {
    return [];
  }

  let anyMigrated = false;
  for (const project of projects) {
    if (!Array.isArray(project.sources)) {
      // Flat-model project — migrate to multi-source shape
      const sc = project.source_config;
      const root = project.root_path ?? "";
      const langs = project.languages ?? [];
      project.sources = [
        {
          source_id: "primary",
          source_config: (sc as Source["source_config"]) ?? {
            type: "code",
            root_path: root,
            languages: langs,
          },
          // No table_name: old shared tables are orphaned; fresh reindex needed
          last_indexed: project.last_indexed,
        },
      ];
      delete project.root_path;
      delete project.languages;
      delete project.source_config;
      delete project.last_indexed;
      anyMigrated = true;
      console.warn(
        `[scrybe] Migrated project '${project.id}' to multi-source model ` +
        `(source_id: "primary"). Run a full reindex to rebuild its vector table.`
      );
    }
  }

  if (anyMigrated) {
    save(projects as Project[]);
  }

  return projects as Project[];
}

function save(projects: Project[]): void {
  mkdirSync(dirname(REGISTRY_PATH), { recursive: true });
  const tmpPath = REGISTRY_PATH + ".tmp";
  writeFileSync(tmpPath, JSON.stringify(projects, null, 2), "utf8");
  try {
    renameSync(tmpPath, REGISTRY_PATH);
  } catch (err: any) {
    if (err.code === "EEXIST") {
      unlinkSync(REGISTRY_PATH);
      renameSync(tmpPath, REGISTRY_PATH);
    } else {
      throw err;
    }
  }
}

// ─── Project CRUD ─────────────────────────────────────────────────────────────

export function listProjects(): Project[] {
  return load();
}

export function getProject(id: string): Project | undefined {
  return load().find((p) => p.id === id);
}

export function addProject(project: Omit<Project, "sources"> & { sources?: Source[] }): void {
  const projects = load();
  if (projects.some((p) => p.id === project.id)) {
    throw new Error(`Project '${project.id}' already exists`);
  }
  projects.push({ ...project, sources: project.sources ?? [] });
  save(projects);
}

export function updateProject(
  id: string,
  fields: Partial<Omit<Project, "id" | "sources">>
): Project {
  const projects = load();
  const idx = projects.findIndex((p) => p.id === id);
  if (idx === -1) throw new Error(`Project '${id}' not found`);
  projects[idx] = { ...projects[idx], ...fields };
  save(projects);
  return projects[idx];
}

export async function removeProject(id: string): Promise<void> {
  const projects = load();
  const project = projects.find((p) => p.id === id);
  if (!project) throw new Error(`Project '${id}' not found`);

  // Drop all source tables
  for (const source of project.sources) {
    if (source.table_name) {
      try {
        await dropTable(source.table_name);
      } catch (err) {
        console.warn(`[scrybe] Failed to drop table '${source.table_name}':`, err);
      }
    }
  }

  save(projects.filter((p) => p.id !== id));
}

// ─── Source CRUD ──────────────────────────────────────────────────────────────

export function addSource(
  projectId: string,
  source: Omit<Source, "table_name" | "last_indexed">
): Source {
  const projects = load();
  const idx = projects.findIndex((p) => p.id === projectId);
  if (idx === -1) throw new Error(`Project '${projectId}' not found`);
  if (projects[idx].sources.some((s) => s.source_id === source.source_id)) {
    throw new Error(`Source '${source.source_id}' already exists in project '${projectId}'`);
  }
  const newSource: Source = { ...source };
  projects[idx].sources.push(newSource);
  save(projects);
  return newSource;
}

export function getSource(projectId: string, sourceId: string): Source | undefined {
  const project = getProject(projectId);
  return project?.sources.find((s) => s.source_id === sourceId);
}

export function updateSource(
  projectId: string,
  sourceId: string,
  fields: Partial<Source>
): Source {
  const projects = load();
  const pIdx = projects.findIndex((p) => p.id === projectId);
  if (pIdx === -1) throw new Error(`Project '${projectId}' not found`);
  const sIdx = projects[pIdx].sources.findIndex((s) => s.source_id === sourceId);
  if (sIdx === -1) throw new Error(`Source '${sourceId}' not found in project '${projectId}'`);
  projects[pIdx].sources[sIdx] = { ...projects[pIdx].sources[sIdx], ...fields };
  save(projects);
  return projects[pIdx].sources[sIdx];
}

export async function removeSource(projectId: string, sourceId: string): Promise<void> {
  const projects = load();
  const pIdx = projects.findIndex((p) => p.id === projectId);
  if (pIdx === -1) throw new Error(`Project '${projectId}' not found`);
  const source = projects[pIdx].sources.find((s) => s.source_id === sourceId);
  if (!source) throw new Error(`Source '${sourceId}' not found in project '${projectId}'`);

  if (source.table_name) {
    try {
      await dropTable(source.table_name);
    } catch (err) {
      console.warn(`[scrybe] Failed to drop table '${source.table_name}':`, err);
    }
  }

  projects[pIdx].sources = projects[pIdx].sources.filter((s) => s.source_id !== sourceId);
  save(projects);
}

// ─── Embedding helpers ────────────────────────────────────────────────────────

/**
 * Resolve the embedding config for a source.
 * If the source has its own embedding config, use it.
 * Otherwise, fall back to the global env var config for the plugin's profile.
 */
export function resolveEmbeddingConfig(source: Source): EmbeddingConfig {
  if (source.embedding) return source.embedding;

  let profile: "code" | "text";
  try {
    profile = getPlugin(source.source_config.type).embeddingProfile;
  } catch {
    profile = "code"; // unknown plugin type — assume code
  }

  if (profile === "code") {
    return {
      base_url: config.embeddingBaseUrl ?? "",
      model: config.embeddingModel,
      dimensions: config.embeddingDimensions,
      api_key_env: "EMBEDDING_API_KEY",
    };
  } else {
    return {
      base_url: config.textEmbeddingBaseUrl ?? config.embeddingBaseUrl ?? "",
      model: config.textEmbeddingModel,
      dimensions: config.textEmbeddingDimensions,
      api_key_env: process.env.SCRYBE_TEXT_EMBEDDING_API_KEY ? "SCRYBE_TEXT_EMBEDDING_API_KEY" : "EMBEDDING_API_KEY",
    };
  }
}

/**
 * Assign a deterministic table name to a source (if not already set) and persist it.
 * Table name = "{prefix}_{sha256(projectId:sourceId:model:dims).slice(0,12)}"
 * This is immutable once assigned — changing embedding config creates a new source/table.
 */
export function assignTableName(projectId: string, source: Source): Source {
  if (source.table_name) return source;

  const emb = resolveEmbeddingConfig(source);
  let profile: "code" | "text";
  try {
    profile = getPlugin(source.source_config.type).embeddingProfile;
  } catch {
    profile = "code";
  }
  const prefix = profile === "code" ? "code" : "knowledge";
  const key = `${projectId}:${source.source_id}:${emb.model}:${emb.dimensions}`;
  const hash = createHash("sha256").update(key).digest("hex").slice(0, 12);
  const table_name = `${prefix}_${hash}`;

  return updateSource(projectId, source.source_id, { table_name });
}

/**
 * Check whether a source can be searched right now.
 * Returns { ok: true } or { ok: false, reason: string }.
 */
export function isSearchable(source: Source): { ok: boolean; reason?: string } {
  if (!source.table_name) {
    return { ok: false, reason: "Never indexed — run a full index first" };
  }
  const emb = resolveEmbeddingConfig(source);
  const key =
    process.env[emb.api_key_env] ??
    process.env["OPENAI_API_KEY"] ??
    "";
  if (!key) {
    return {
      ok: false,
      reason:
        `Requires env var ${emb.api_key_env} (model: ${emb.model}) — ` +
        `not set in current environment`,
    };
  }
  return { ok: true };
}
