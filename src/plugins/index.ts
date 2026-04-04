import { CodePlugin } from "./code.js";
import type { SourcePlugin } from "./base.js";

const registry: Record<string, SourcePlugin> = {
  code: new CodePlugin(),
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
