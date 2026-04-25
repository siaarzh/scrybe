import { describe, it, expect } from "vitest";

// Expected hint table from M-D10 plan (tools not listed = no annotation required)
const EXPECTED: Record<string, {
  readOnlyHint?: boolean;
  destructiveHint?: boolean;
  idempotentHint?: boolean;
  openWorldHint?: boolean;
}> = {
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
  it("loads tool list from mcpTools registry", async () => {
    const { mcpTools } = await import("../src/tools/all-tools.js");
    expect(mcpTools.length).toBeGreaterThan(0);
  });

  for (const [toolName, expected] of Object.entries(EXPECTED)) {
    it(`${toolName} has correct annotations`, async () => {
      const { mcpTools } = await import("../src/tools/all-tools.js");
      const tool = mcpTools.find((t) => t.spec.name === toolName);
      expect(tool, `tool '${toolName}' not found in mcpTools`).toBeDefined();
      const hints = tool!.spec.annotations ?? {};
      for (const [key, value] of Object.entries(expected)) {
        expect(
          (hints as Record<string, boolean | undefined>)[key],
          `${toolName}.annotations.${key}`
        ).toBe(value);
      }
    });
  }
});
