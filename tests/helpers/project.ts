/**
 * Contract 4 — Temp project registration.
 * Registers a project + code source in the isolated SCRYBE_DATA_DIR,
 * wired to the local WASM embedder sidecar.
 * Uses dynamic imports so config.ts picks up fresh env vars after vi.resetModules().
 */
import { randomBytes } from "crypto";
import { sidecar } from "./sidecar.js";

export interface TempProject {
  projectId: string;
  sourceId: string;
  rootPath: string;
  cleanup(): Promise<void>;
}

export interface CreateTempProjectOptions {
  rootPath: string;
  sourceId?: string;
  languages?: string[];
  // M-D1 will add: branch?: string;
}

export async function createTempProject(opts: CreateTempProjectOptions): Promise<TempProject> {
  const { addProject, addSource } = await import("../../src/registry.js");

  const projectId = `test-${randomBytes(4).toString("hex")}`;
  const sourceId = opts.sourceId ?? "primary";

  addProject({ id: projectId, description: `Test project ${projectId}` });
  addSource(projectId, {
    source_id: sourceId,
    source_config: {
      type: "code",
      root_path: opts.rootPath,
      languages: opts.languages ?? ["ts"],
    },
    embedding: {
      base_url: sidecar.baseUrl,
      model: sidecar.model,
      dimensions: sidecar.dimensions,
      api_key_env: "EMBEDDING_API_KEY",
    },
  });

  return {
    projectId,
    sourceId,
    rootPath: opts.rootPath,
    async cleanup() {
      try {
        const { removeProject } = await import("../../src/registry.js");
        await removeProject(projectId);
      } catch {
        // ignore cleanup errors
      }
    },
  };
}
