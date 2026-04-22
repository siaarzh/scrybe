/**
 * Pinned-branches — per-source allowlist for background daemon indexing.
 * Shared by CLI, MCP tools, and HTTP API (Amendment A1 / §4.5 / §10.5).
 * Persists to projects.json via registry.updateSource().
 */
import { getProject, getSource, updateSource } from "./registry.js";

const PINNED_WARNING_THRESHOLD = 20;

export class InvalidSourceTypeError extends Error {
  readonly code = "invalid_source_type";
  constructor(projectId: string, sourceId: string) {
    super(`Source '${sourceId}' in project '${projectId}' is not a code source. Pinned branches only apply to code sources.`);
  }
}

export class SourceNotFoundError extends Error {
  readonly code = "source_not_found";
  constructor(projectId: string, sourceId: string) {
    super(`Source '${sourceId}' not found in project '${projectId}'`);
  }
}

export class ProjectNotFoundError extends Error {
  readonly code = "project_not_found";
  constructor(projectId: string) {
    super(`Project '${projectId}' not found`);
  }
}

function getCodeSource(projectId: string, sourceId: string) {
  const project = getProject(projectId);
  if (!project) throw new ProjectNotFoundError(projectId);
  const source = project.sources.find((s) => s.source_id === sourceId);
  if (!source) throw new SourceNotFoundError(projectId, sourceId);
  if (source.source_config.type !== "code") throw new InvalidSourceTypeError(projectId, sourceId);
  return source;
}

function buildWarnings(count: number, projectId: string, sourceId: string): string[] {
  if (count > PINNED_WARNING_THRESHOLD) {
    return [
      `Project '${projectId}' source '${sourceId}' has ${count} pinned branches. ` +
      `Indexing many branches increases disk usage and fetch time. ` +
      `Review with: scrybe pin list --project-id ${projectId} --source-id ${sourceId}`,
    ];
  }
  return [];
}

export function listPinned(projectId: string, sourceId: string): string[] {
  const source = getCodeSource(projectId, sourceId);
  return source.pinned_branches ?? [];
}

export function addPinned(
  projectId: string,
  sourceId: string,
  branches: string[],
  mode: "add" | "set" = "add"
): { branches: string[]; added: string[]; warnings: string[] } {
  const source = getCodeSource(projectId, sourceId);
  const existing = source.pinned_branches ?? [];

  let next: string[];
  let added: string[];

  if (mode === "set") {
    next = [...new Set(branches)];
    added = next.filter((b) => !existing.includes(b));
  } else {
    const incoming = branches.filter((b) => !existing.includes(b));
    next = [...existing, ...incoming];
    added = incoming;
  }

  updateSource(projectId, sourceId, { pinned_branches: next });
  return { branches: next, added, warnings: buildWarnings(next.length, projectId, sourceId) };
}

export function removePinned(
  projectId: string,
  sourceId: string,
  branches: string[]
): { branches: string[]; removed: string[] } {
  const source = getCodeSource(projectId, sourceId);
  const existing = source.pinned_branches ?? [];
  const removed = branches.filter((b) => existing.includes(b));
  const next = existing.filter((b) => !branches.includes(b));
  updateSource(projectId, sourceId, { pinned_branches: next });
  return { branches: next, removed };
}

export function clearPinned(
  projectId: string,
  sourceId: string
): { branches: string[]; removed: string[] } {
  const source = getCodeSource(projectId, sourceId);
  const removed = source.pinned_branches ?? [];
  updateSource(projectId, sourceId, { pinned_branches: [] });
  return { branches: [], removed };
}
