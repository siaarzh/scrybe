import { CodePlugin } from "./code.js";
import { GitLabIssuesPlugin } from "./gitlab-issues.js";
import { GitHubIssuesPlugin } from "./github-issues.js";
import type { SourcePlugin } from "./base.js";
import type { Project, Source } from "../types.js";
import type { AnyChunk } from "./base.js";

const gitlabPlugin = new GitLabIssuesPlugin();
const githubPlugin = new GitHubIssuesPlugin();

/**
 * Provider-aware router for ticket sources.
 * Dispatches scanSources/fetchChunks to the gitlab or github plugin based on
 * source_config.provider (default: "gitlab" for back-compat).
 */
const ticketRouter: SourcePlugin = {
  type: "ticket",
  embeddingProfile: "text",

  scanSources(project: Project, source: Source, cursor?: string | null): Promise<Record<string, string>> {
    const cfg = source.source_config as { type: string; provider?: string };
    if (cfg.provider === "github") {
      return githubPlugin.scanSources(project, source, cursor);
    }
    return gitlabPlugin.scanSources(project, source, cursor);
  },

  async *fetchChunks(project: Project, source: Source, changed: Set<string>): AsyncGenerator<AnyChunk> {
    const cfg = source.source_config as { type: string; provider?: string };
    if (cfg.provider === "github") {
      yield* githubPlugin.fetchChunks(project, source, changed);
    } else {
      yield* gitlabPlugin.fetchChunks(project, source, changed);
    }
  },
};

const registry: Record<string, SourcePlugin> = {
  code: new CodePlugin(),
  ticket: ticketRouter,
};

export function getPlugin(type: string): SourcePlugin {
  const plugin = registry[type];
  if (!plugin) throw new Error(`No plugin registered for source type "${type}"`);
  return plugin;
}

/** Register a plugin at runtime (used by future knowledge plugins). */
export function registerPlugin(plugin: SourcePlugin): void {
  registry[plugin.type] = plugin;
}
