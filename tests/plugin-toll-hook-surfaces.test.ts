import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

/**
 * Table-driven cross-surface regression net for the search toll's `auto`
 * rule. The bug this plan fixes (the rule was inverted — refusing listing
 * and allowing keyword search) survived because no test exercised the MCP
 * surface at all; every case lived in `tests/plugin-toll-hook.test.ts` as a
 * shell command. This file walks every (surface × shape) combination once,
 * so a future inversion on any one surface fails loudly instead of quietly.
 */

const HOOK = join(process.cwd(), "plugins", "scrybe", "hooks", "scrybe-toll.mjs");

let sandbox: string;

function writeProjects(ticketIndexedAt: string | null = new Date().toISOString()): void {
  const sources: unknown[] = [{ source_id: "primary", source_config: { type: "code", root_path: INDEXED } }];
  if (ticketIndexedAt !== undefined) {
    sources.push({
      source_id: "issues",
      source_config: { type: "ticket" },
      ...(ticketIndexedAt !== null ? { last_indexed: ticketIndexedAt } : {}),
    });
  }
  writeFileSync(join(sandbox, "projects.json"), JSON.stringify([{ id: "indexed-project", sources }]));
}

function writeConfig(overrides: Record<string, unknown> = {}): void {
  writeFileSync(
    join(sandbox, "toll.json"),
    JSON.stringify({ marker_dir: sandbox, max_index_age_seconds: 86400, ...overrides })
  );
}

function run(payload: unknown): { stdout: string; json: Record<string, any> | null; code: number } {
  const result = spawnSync(process.execPath, [HOOK, "PreToolUse"], {
    input: typeof payload === "string" ? payload : JSON.stringify(payload),
    env: { ...process.env, SCRYBE_DATA_DIR: sandbox },
    encoding: "utf8",
  });
  const stdout = result.stdout ?? "";
  let json: Record<string, any> | null = null;
  try {
    json = stdout.trim() ? JSON.parse(stdout) : null;
  } catch {
    json = null;
  }
  return { stdout, json, code: result.status ?? -1 };
}

function decision(json: Record<string, any> | null): string | undefined {
  return json?.hookSpecificOutput?.permissionDecision;
}

const INDEXED = "/fake/repo/indexed";

function bash(command: string, cwd = INDEXED) {
  return {
    hook_event_name: "PreToolUse",
    session_id: "session-a",
    cwd,
    tool_name: "Bash",
    tool_input: { command },
  };
}

function mcp(toolName: string, toolInput: Record<string, unknown>, cwd = INDEXED) {
  return {
    hook_event_name: "PreToolUse",
    session_id: "session-a",
    cwd,
    tool_name: toolName,
    tool_input: toolInput,
  };
}

beforeEach(() => {
  sandbox = mkdtempSync(join(tmpdir(), "scrybe-toll-surfaces-test-"));
  writeProjects();
  writeConfig();
});

afterEach(() => {
  rmSync(sandbox, { recursive: true, force: true });
});

type Row = { surface: string; shape: string; payload: () => unknown; expect: "allow" | "deny" };

const rows: Row[] = [
  // --- gh ---
  { surface: "gh", shape: "bare list", payload: () => bash("gh issue list"), expect: "allow" },
  {
    surface: "gh",
    shape: "structured filter",
    payload: () => bash("gh issue list --milestone 26.8"),
    expect: "allow",
  },
  {
    surface: "gh",
    shape: "free text",
    payload: () => bash('gh issue list --search "crash on save"'),
    expect: "deny",
  },
  {
    surface: "gh",
    shape: "qualifier-only",
    payload: () => bash('gh issue list -S "no:assignee sort:created-asc"'),
    expect: "allow",
  },
  { surface: "gh", shape: "--help", payload: () => bash("gh issue list --help"), expect: "allow" },
  {
    surface: "gh",
    shape: "free text (search issues subcommand)",
    payload: () => bash("gh search issues memory daemon"),
    expect: "deny",
  },

  // --- glab ---
  { surface: "glab", shape: "bare list", payload: () => bash("glab issue list"), expect: "allow" },
  {
    surface: "glab",
    shape: "structured filter",
    payload: () => bash("glab issue list --milestone 26.8"),
    expect: "allow",
  },
  { surface: "glab", shape: "free text", payload: () => bash("glab issue list --search crash"), expect: "deny" },
  {
    surface: "glab",
    shape: "qualifier-only",
    payload: () => bash('glab issue list --search "no:assignee sort:created-asc"'),
    expect: "allow",
  },
  { surface: "glab", shape: "--help", payload: () => bash("glab issue list --help"), expect: "allow" },

  // --- mcp__gitlab__* ---
  {
    surface: "mcp__gitlab__*",
    shape: "bare list",
    payload: () => mcp("mcp__gitlab__list_issues", { project_id: "34" }),
    expect: "allow",
  },
  {
    surface: "mcp__gitlab__*",
    shape: "structured filter (state)",
    payload: () => mcp("mcp__gitlab__list_issues", { project_id: "34", state: "opened" }),
    expect: "allow",
  },
  {
    surface: "mcp__gitlab__*",
    shape: "structured filter (milestone)",
    payload: () => mcp("mcp__gitlab__list_issues", { project_id: "34", milestone: "26.8" }),
    expect: "allow",
  },
  {
    surface: "mcp__gitlab__*",
    shape: "free text",
    payload: () => mcp("mcp__gitlab__list_issues", { project_id: "34", search: "crash" }),
    expect: "deny",
  },
  {
    surface: "mcp__gitlab__*",
    shape: "qualifier-only",
    payload: () => mcp("mcp__gitlab__list_issues", { project_id: "34", search: "no:assignee sort:created-asc" }),
    expect: "allow",
  },
  {
    surface: "mcp__gitlab__*",
    shape: "bare list (my_issues)",
    payload: () => mcp("mcp__gitlab__my_issues", {}),
    expect: "allow",
  },
  {
    surface: "mcp__gitlab__*",
    shape: "free text (my_issues)",
    payload: () => mcp("mcp__gitlab__my_issues", { search: "crash" }),
    expect: "deny",
  },

  // --- mcp__gitlab-gql__* ---
  {
    surface: "mcp__gitlab-gql__*",
    shape: "structured filter (search_issues)",
    payload: () => mcp("mcp__gitlab-gql__search_issues", { labelNames: ["bug"] }),
    expect: "allow",
  },
  {
    surface: "mcp__gitlab-gql__*",
    shape: "free text (search_issues)",
    payload: () => mcp("mcp__gitlab-gql__search_issues", { searchTerm: "crash" }),
    expect: "deny",
  },
  {
    surface: "mcp__gitlab-gql__*",
    shape: "qualifier-only (search_issues)",
    payload: () => mcp("mcp__gitlab-gql__search_issues", { searchTerm: "no:assignee sort:created-asc" }),
    expect: "allow",
  },
  {
    surface: "mcp__gitlab-gql__*",
    shape: "bare list (search_gitlab)",
    payload: () => mcp("mcp__gitlab-gql__search_gitlab", {}),
    expect: "allow",
  },
  {
    surface: "mcp__gitlab-gql__*",
    shape: "free text (search_gitlab)",
    payload: () => mcp("mcp__gitlab-gql__search_gitlab", { searchTerm: "crash" }),
    expect: "deny",
  },
  {
    surface: "mcp__gitlab-gql__*",
    shape: "free text (search_notes)",
    payload: () => mcp("mcp__gitlab-gql__search_notes", { search: "crash" }),
    expect: "deny",
  },
  {
    surface: "mcp__gitlab-gql__*",
    shape: "search_only fires even with no params (search_notes)",
    payload: () => mcp("mcp__gitlab-gql__search_notes", {}),
    expect: "deny",
  },
  {
    surface: "mcp__gitlab-gql__*",
    shape: "unguarded tool (get_issues)",
    payload: () => mcp("mcp__gitlab-gql__get_issues", { projectPath: "intra/cmx" }),
    expect: "allow",
  },
  {
    surface: "mcp__gitlab-gql__*",
    shape: "unguarded tool (get_user_issues)",
    payload: () => mcp("mcp__gitlab-gql__get_user_issues", { username: "serzh" }),
    expect: "allow",
  },
  {
    surface: "mcp__gitlab-gql__*",
    shape: "unguarded tool (list_work_items)",
    payload: () => mcp("mcp__gitlab-gql__list_work_items", { fullPath: "intra/cmx" }),
    expect: "allow",
  },
];

describe.each(rows)("$surface / $shape", (row) => {
  it(`${row.expect === "allow" ? "allows" : "denies"}`, () => {
    const { json, stdout } = run(row.payload());
    if (row.expect === "allow") {
      expect(stdout).toBe("");
    } else {
      expect(decision(json)).toBe("deny");
    }
  });
});

describe("coverage gate applies identically regardless of surface", () => {
  it("allows a free-text search in an unindexed cwd", () => {
    expect(run(bash('gh issue list --search "crash"', "/fake/repo/unregistered")).stdout).toBe("");
  });

  it("allows a free-text search when the ticket index is stale", () => {
    writeProjects(new Date(Date.now() - 172_800_000).toISOString()); // 2 days old
    writeConfig({ max_index_age_seconds: 86400 });
    expect(run(bash('gh issue list --search "crash"')).stdout).toBe("");
  });

  it("allows an MCP free-text search in an unregistered cwd", () => {
    expect(
      run(mcp("mcp__gitlab__list_issues", { project_id: "34", search: "crash" }, "/fake/repo/unregistered")).stdout
    ).toBe("");
  });

  it("allows an MCP free-text search when the ticket index is stale", () => {
    writeProjects(new Date(Date.now() - 172_800_000).toISOString()); // 2 days old
    writeConfig({ max_index_age_seconds: 86400 });
    expect(run(mcp("mcp__gitlab__list_issues", { project_id: "34", search: "crash" })).stdout).toBe("");
  });
});
