import { describe, it, expect } from "vitest";

// Import the TOOLS array by reading it from the built output.
// We parse the mcp-server source to extract the tool list without spinning up the server.
// Using dynamic import of the module is simpler and avoids server startup.

type ToolHints = {
  readOnlyHint?: boolean;
  destructiveHint?: boolean;
  idempotentHint?: boolean;
  openWorldHint?: boolean;
};

type ToolDef = {
  name: string;
  annotations?: ToolHints;
};

// Expected hint table from the plan (tools not listed = no annotation required)
const EXPECTED: Record<string, ToolHints> = {
  list_projects:       { readOnlyHint: true,  openWorldHint: false },
  list_branches:       { readOnlyHint: true,  openWorldHint: false },
  list_jobs:           { readOnlyHint: true,  openWorldHint: false },
  list_pinned_branches:{ readOnlyHint: true,  openWorldHint: false },
  search_code:         { readOnlyHint: true,  openWorldHint: false },
  search_knowledge:    { readOnlyHint: true,  openWorldHint: false },
  reindex_status:      { readOnlyHint: true,  openWorldHint: false },
  reindex_project:     { idempotentHint: true, openWorldHint: true },
  reindex_source:      { idempotentHint: true, openWorldHint: true },
  reindex_all:         { idempotentHint: true, openWorldHint: true },
  pin_branches:        { idempotentHint: true, openWorldHint: false },
  unpin_branches:      { idempotentHint: true, openWorldHint: false },
  cancel_reindex:      { idempotentHint: true, openWorldHint: false },
  update_project:      { openWorldHint: false },
  update_source:       { openWorldHint: false },
  remove_project:      { destructiveHint: true, openWorldHint: false },
  remove_source:       { destructiveHint: true, openWorldHint: false },
};

describe("MCP tool annotations", () => {
  let tools: ToolDef[];

  it("loads tool list from mcp-server", async () => {
    // We can't import runMcpServer without it trying to start stdio transport,
    // so we test by importing the dist module and intercepting ListTools via
    // a simple source-file parse approach: just read and eval the TOOLS const.
    // Simpler: import the compiled module and extract TOOLS from the handler.
    // The cleanest way: re-export TOOLS from the module under a named export for tests.
    // Since we don't want to change the production API surface, we read the source directly.
    const { readFileSync } = await import("fs");
    const { join } = await import("path");
    const src = readFileSync(join(process.cwd(), "src", "mcp-server.ts"), "utf8");
    // Extract all tool name + annotations pairs using regex
    const toolNames: string[] = [];
    const nameRe = /name:\s*"([^"]+)"/g;
    let m: RegExpExecArray | null;
    while ((m = nameRe.exec(src)) !== null) {
      toolNames.push(m[1]);
    }
    expect(toolNames.length).toBeGreaterThan(0);
    tools = toolNames.map((name) => ({ name }));
    // Inject annotations by re-parsing annotations blocks per tool
    tools = parseToolAnnotations(src);
  });

  for (const [toolName, expected] of Object.entries(EXPECTED)) {
    it(`${toolName} has correct annotations`, () => {
      expect(tools, "tools list not loaded").toBeDefined();
      const tool = tools.find((t) => t.name === toolName);
      expect(tool, `tool '${toolName}' not found in TOOLS`).toBeDefined();
      const hints = tool!.annotations ?? {};
      for (const [key, value] of Object.entries(expected)) {
        expect(hints[key as keyof ToolHints], `${toolName}.annotations.${key}`).toBe(value);
      }
    });
  }
});

function parseToolAnnotations(src: string): ToolDef[] {
  // Split on tool object boundaries (each starts with `  {` and `name:`)
  // We find all `{ name: "X", ..., annotations: { ... } }` blocks
  const results: ToolDef[] = [];

  // Match each tool block: between `name: "X"` and the next top-level `},`
  const toolBlockRe = /\{\s*\n\s*name:\s*"([^"]+)"([\s\S]*?)(?=\n  \{|\n\];)/g;
  let m: RegExpExecArray | null;
  while ((m = toolBlockRe.exec(src)) !== null) {
    const name = m[1];
    const body = m[2];
    const annotationsMatch = body.match(/annotations:\s*\{([^}]+)\}/);
    if (!annotationsMatch) {
      results.push({ name });
      continue;
    }
    const hintsBody = annotationsMatch[1];
    const hints: ToolHints = {};
    const kvRe = /(\w+):\s*(true|false)/g;
    let kv: RegExpExecArray | null;
    while ((kv = kvRe.exec(hintsBody)) !== null) {
      (hints as Record<string, boolean>)[kv[1]] = kv[2] === "true";
    }
    results.push({ name, annotations: hints });
  }
  return results;
}
