import { readFileSync, writeFileSync, mkdirSync, existsSync } from "fs";
import { join, dirname } from "path";
import { config } from "./config.js";
import type { Project } from "./types.js";

const REGISTRY_PATH = join(config.dataDir, "projects.json");

function load(): Project[] {
  if (!existsSync(REGISTRY_PATH)) return [];
  try {
    return JSON.parse(readFileSync(REGISTRY_PATH, "utf8")) as Project[];
  } catch {
    return [];
  }
}

function save(projects: Project[]): void {
  mkdirSync(dirname(REGISTRY_PATH), { recursive: true });
  writeFileSync(REGISTRY_PATH, JSON.stringify(projects, null, 2), "utf8");
}

export function listProjects(): Project[] {
  return load();
}

export function getProject(id: string): Project | undefined {
  return load().find((p) => p.id === id);
}

export function addProject(project: Project): void {
  const projects = load();
  if (projects.some((p) => p.id === project.id)) {
    throw new Error(`Project '${project.id}' already exists`);
  }
  projects.push(project);
  save(projects);
}

export function updateProject(
  id: string,
  fields: Partial<Omit<Project, "id">>
): Project {
  const projects = load();
  const idx = projects.findIndex((p) => p.id === id);
  if (idx === -1) throw new Error(`Project '${id}' not found`);
  projects[idx] = { ...projects[idx], ...fields };
  save(projects);
  return projects[idx];
}

export function removeProject(id: string): void {
  const projects = load();
  const filtered = projects.filter((p) => p.id !== id);
  if (filtered.length === projects.length) {
    throw new Error(`Project '${id}' not found`);
  }
  save(filtered);
}
