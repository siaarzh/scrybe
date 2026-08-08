import { spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, rmSync, statSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

/**
 * The plugin's PreToolUse/PostToolUse hook. It is a standalone .mjs, not part
 * of the TypeScript build, so it is exercised the way Claude Code runs it:
 * spawned as a process with the payload on stdin.
 */
const HOOK = join(process.cwd(), "plugins", "scrybe", "hooks", "scrybe-toll.mjs");

let sandbox: string;

/** Where scrybe-toll.mjs writes its marker, given the config below. */
function marker(scope = "global"): string {
  return join(sandbox, `scrybe-toll-${scope}`);
}

function writeConfig(overrides: Record<string, unknown> = {}): void {
  if (!existsSync(join(sandbox, "projects.json"))) writeProjects();
  writeFileSync(
    join(sandbox, "toll.json"),
    JSON.stringify({ marker_dir: sandbox, max_index_age_seconds: 86400, ...overrides })
  );
}

/** Force the unconditional ban, which is no longer the shipped default. */
const BAN = { guards: [{ id: "gh-issue-list", action: "deny", pattern: "\\bgh\\s+issue\\s+list\\b" }] };

/** Backdate the marker so a specific age can be asserted without sleeping. */
function ageMarker(seconds: number, scope = "global"): void {
  const when = new Date(Date.now() - seconds * 1000);
  utimesSync(marker(scope), when, when);
}

function run(
  event: "PreToolUse" | "PostToolUse",
  payload: unknown
): { stdout: string; json: Record<string, any> | null; code: number } {
  const result = spawnSync(process.execPath, [HOOK, event], {
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

const INDEXED = "/fake/repo/indexed";
const CODE_ONLY = "/fake/repo/code-only";

function bash(command: string, sessionId = "session-a", cwd = INDEXED) {
  return {
    hook_event_name: "PreToolUse",
    session_id: sessionId,
    cwd,
    tool_name: "Bash",
    tool_input: { command },
  };
}

/** A projects.json the `auto` action can read: one indexed repo, one code-only. */
function writeProjects(ticketIndexedAt = new Date().toISOString()): void {
  writeFileSync(
    join(sandbox, "projects.json"),
    JSON.stringify([
      {
        id: "indexed-project",
        sources: [
          { source_id: "primary", source_config: { type: "code", root_path: INDEXED } },
          { source_id: "issues", source_config: { type: "ticket" }, last_indexed: ticketIndexedAt },
        ],
      },
      {
        id: "code-only-project",
        sources: [{ source_id: "primary", source_config: { type: "code", root_path: CODE_ONLY } }],
      },
    ])
  );
}

function decision(json: Record<string, any> | null): string | undefined {
  return json?.hookSpecificOutput?.permissionDecision;
}

beforeEach(() => {
  sandbox = mkdtempSync(join(tmpdir(), "scrybe-toll-test-"));
});

afterEach(() => {
  rmSync(sandbox, { recursive: true, force: true });
});

/** The shipped guards ban outright; the timed toll is opt-in. */
const TOLL_GUARD = {
  guards: [
    { id: "gh-issue-list", action: "toll", pattern: "\\bgh\\s+issue\\s+list\\b", hint: "search_knowledge finds it" },
  ],
};

describe("shipped default: auto — refuse only when Scrybe can answer", () => {
  beforeEach(() => writeConfig());

  it.each([
    "gh issue list",
    'gh issue list --search "crash on save"',
    "gh search issues memory",
  ])("refuses a similarity question in an indexed repo: %s", (command) => {
    expect(decision(run("PreToolUse", bash(command)).json)).toBe("deny");
  });

  it("names the project so the agent does not have to guess it", () => {
    const reason = run("PreToolUse", bash("gh issue list")).json?.hookSpecificOutput
      .permissionDecisionReason as string;
    expect(reason).toContain("indexed-project");
  });

  it.each([
    "gh issue list --milestone 26.8 --state open",
    "gh issue list --assignee @me",
    "gh issue list --label bug --json number,title",
  ])("allows a census, which has no semantic equivalent: %s", (command) => {
    expect(run("PreToolUse", bash(command)).stdout).toBe("");
  });

  it("treats free text as a similarity question even beside a filter", () => {
    // Otherwise adding --state would be a one-flag bypass of the whole guard.
    expect(decision(run("PreToolUse", bash('gh issue list --state open --search "crash"')).json)).toBe(
      "deny"
    );
  });

  it("allows when no project covers this directory", () => {
    expect(run("PreToolUse", bash("gh issue list", "s", "/fake/repo/unregistered")).stdout).toBe("");
  });

  it("allows when the project has code indexed but no issues", () => {
    expect(run("PreToolUse", bash("gh issue list", "s", CODE_ONLY)).stdout).toBe("");
  });

  it("allows when the issue index is older than the threshold", () => {
    writeProjects(new Date(Date.now() - 172_800_000).toISOString()); // 2 days
    writeConfig({ max_index_age_seconds: 86400 });
    expect(run("PreToolUse", bash("gh issue list")).stdout).toBe("");
  });

  it("allows when the index has no timestamp at all", () => {
    writeFileSync(
      join(sandbox, "projects.json"),
      JSON.stringify([
        {
          id: "never-indexed",
          sources: [
            { source_id: "primary", source_config: { type: "code", root_path: INDEXED } },
            { source_id: "issues", source_config: { type: "ticket" } },
          ],
        },
      ])
    );
    expect(run("PreToolUse", bash("gh issue list")).stdout).toBe("");
  });

  it("tells the agent the census route exists, so a refusal is not a dead end", () => {
    const reason = run("PreToolUse", bash("gh issue list")).json?.hookSpecificOutput
      .permissionDecisionReason as string;
    expect(reason).toContain("CENSUS");
    expect(reason).toContain("--milestone");
  });

  it("still refuses the guarded MCP tools", () => {
    const { json } = run("PreToolUse", {
      hook_event_name: "PreToolUse",
      session_id: "s",
      cwd: INDEXED,
      tool_name: "mcp__gitlab__list_issues",
      tool_input: { project_id: 34 },
    });
    expect(decision(json)).toBe("deny");
  });

  it("allows everything when projects.json cannot be read", () => {
    // No index means no replacement to offer, so refusing would strand the agent.
    rmSync(join(sandbox, "projects.json"));
    expect(run("PreToolUse", bash("gh issue list")).stdout).toBe("");
  });
});

/**
 * The census exemption has to be reachable from a tool call, not only from a
 * shell. A guarded MCP call carries no command string, so reading only
 * `tool_input.command` refused every one of them — including the filtered
 * census the guard is supposed to allow — and then told the caller to retry
 * with shell flags it cannot pass.
 */
describe("auto over MCP tool parameters", () => {
  beforeEach(() => writeConfig());

  function mcp(toolName: string, toolInput: Record<string, unknown>, cwd = INDEXED) {
    return {
      hook_event_name: "PreToolUse",
      session_id: "s",
      cwd,
      tool_name: toolName,
      tool_input: toolInput,
    };
  }

  it.each([
    ["milestone", "mcp__gitlab__list_issues", { project_id: "34", milestone: "26.8" }],
    ["assignee", "mcp__gitlab__list_issues", { project_id: "34", assignee_username: ["serzh"] }],
    ["labels", "mcp__gitlab__list_issues", { project_id: "34", labels: ["bug"] }],
    ["state", "mcp__gitlab__list_issues", { project_id: "34", state: "closed" }],
    ["author", "mcp__gitlab-gql__search_issues", { projectPath: "intra/cmx", authorUsername: "serzh" }],
    ["label names", "mcp__gitlab-gql__search_issues", { labelNames: ["Priority::High"] }],
    ["a named user", "mcp__gitlab-gql__get_user_issues", { username: "serzh" }],
    ["work item types", "mcp__gitlab-gql__list_work_items", { fullPath: "intra/cmx", types: ["TASK"] }],
  ])("allows a census expressed as a parameter: %s", (_label, tool, input) => {
    expect(run("PreToolUse", mcp(tool, input)).stdout).toBe("");
  });

  it.each([
    ["a bare project list", "mcp__gitlab__list_issues", { project_id: "34" }],
    ["paging only", "mcp__gitlab__list_issues", { project_id: "34", per_page: 100, page: 2 }],
    ["sorting only", "mcp__gitlab-gql__get_issues", { projectPath: "intra/cmx", sort: "UPDATED_DESC" }],
    ["a bare namespace", "mcp__gitlab-gql__list_work_items", { fullPath: "intra/cmx" }],
  ])("still refuses an unfiltered list: %s", (_label, tool, input) => {
    expect(decision(run("PreToolUse", mcp(tool, input)).json)).toBe("deny");
  });

  it.each([
    ["state: all", { project_id: "34", state: "all" }],
    ["scope: all", { project_id: "34", scope: "all" }],
    ["an empty label array", { project_id: "34", labels: [] }],
    ["an empty milestone", { project_id: "34", milestone: "  " }],
  ])("does not accept a value that narrows nothing: %s", (_label, input) => {
    expect(decision(run("PreToolUse", mcp("mcp__gitlab__list_issues", input)).json)).toBe("deny");
  });

  it.each([
    ["search", { project_id: "34", state: "opened", search: "crash on save" }],
    ["searchTerm", { projectPath: "intra/cmx", labelNames: ["bug"], searchTerm: "crash on save" }],
  ])("treats free text as similarity even beside a filter: %s", (_label, input) => {
    // Otherwise one filter parameter is a bypass of the whole guard.
    expect(decision(run("PreToolUse", mcp("mcp__gitlab__list_issues", input)).json)).toBe("deny");
  });

  it("allows a census naming the exact issues wanted", () => {
    expect(run("PreToolUse", mcp("mcp__gitlab__list_issues", { project_id: "34", iids: [11, 12] })).stdout).toBe("");
  });

  it.each([
    ["glab issue list --state opened", ""],
    ["glab issue list --milestone 26.8", ""],
  ])("does not regress the shell surface: %s stays allowed", (command) => {
    expect(run("PreToolUse", bash(command)).stdout).toBe("");
  });

  it("still refuses a bare shell list on the other CLI too", () => {
    expect(decision(run("PreToolUse", bash("glab issue list")).json)).toBe("deny");
  });

  it.each([
    ["no parameters at all", undefined],
    ["an empty parameter object", {}],
    ["parameters that are not an object", "truncated"],
  ])("refuses rather than allows when the payload arrives damaged: %s", (_label, input) => {
    // The surface is keyed on the ABSENCE of a command, so it is worth pinning
    // that absence cannot itself produce an allowance: the allow needs a
    // positive match on a narrowing parameter, and a damaged payload has none.
    expect(decision(run("PreToolUse", mcp("mcp__gitlab__list_issues", input as any)).json)).toBe("deny");
  });

  it("names a route the tool caller can actually take", () => {
    const reason = run("PreToolUse", mcp("mcp__gitlab__list_issues", { project_id: "34" })).json
      ?.hookSpecificOutput.permissionDecisionReason as string;
    expect(reason).toContain("CENSUS");
    expect(reason).toContain("milestone");
    // Shell flags are unreachable from a tool call, so offering them strands the caller.
    expect(reason).not.toContain("--milestone");
  });

  it("keeps the shell wording for a shell call", () => {
    const reason = run("PreToolUse", bash("gh issue list")).json?.hookSpecificOutput
      .permissionDecisionReason as string;
    expect(reason).toContain("--milestone");
  });

  it("allows a census even where Scrybe has no index at all", () => {
    // Coverage is never consulted once the call is enumeration-shaped.
    expect(run("PreToolUse", mcp("mcp__gitlab__list_issues", { milestone: "26.8" }, CODE_ONLY)).stdout).toBe("");
  });
});

describe("deny action: a ban, not a wait", () => {
  beforeEach(() => writeConfig(BAN));

  it("denies every attempt, with nothing to wait for", () => {
    for (let attempt = 0; attempt < 3; attempt += 1) {
      const { json } = run("PreToolUse", bash("gh issue list"));
      expect(decision(json)).toBe("deny");
      const reason = json?.hookSpecificOutput.permissionDecisionReason as string;
      expect(reason).toContain("NOT ALLOWED");
      expect(reason).toContain("This is not a wait");
      expect(reason).not.toMatch(/\d+ seconds/);
    }
  });

  it("keeps no state at all, so nothing can expire into an allowance", () => {
    run("PreToolUse", bash("gh issue list"));
    expect(() => statSync(marker())).toThrow();
  });

  it("stays denied however long the caller waits", () => {
    run("PreToolUse", bash("gh issue list"));
    // No marker exists to age; a second call an hour later is identical.
    expect(decision(run("PreToolUse", bash("gh issue list")).json)).toBe("deny");
  });

  it("treats a guard with no action at all as a ban", () => {
    writeConfig({ guards: [{ id: "bare", pattern: "\\bgh\\s+issue\\s+list\\b" }] });
    const reason = run("PreToolUse", bash("gh issue list")).json?.hookSpecificOutput
      .permissionDecisionReason as string;
    expect(reason).toContain("NOT ALLOWED");
  });
});

describe("toll state machine (opt-in)", () => {
  beforeEach(() => writeConfig(TOLL_GUARD));

  it("denies the first attempt and writes the marker", () => {
    const { json } = run("PreToolUse", bash("gh issue list --repo owner/repo"));
    expect(decision(json)).toBe("deny");
    expect(json?.hookSpecificOutput.permissionDecisionReason).toContain("in 15 seconds");
    expect(() => statSync(marker())).not.toThrow();
  });

  it("keeps denying inside the wait, and does not restart it", () => {
    run("PreToolUse", bash("gh issue list"));
    const first = statSync(marker()).mtimeMs;

    ageMarker(10);
    const { json } = run("PreToolUse", bash("gh issue list"));

    expect(decision(json)).toBe("deny");
    expect(json?.hookSpecificOutput.permissionDecisionReason).toContain("in 5 seconds");
    // The marker must NOT be rewritten — otherwise the wait never ends.
    expect(statSync(marker()).mtimeMs).toBeLessThan(first);
  });

  it("reports a whole second of wait rather than zero", () => {
    run("PreToolUse", bash("gh issue list"));
    ageMarker(14.2);
    const { json } = run("PreToolUse", bash("gh issue list"));
    expect(json?.hookSpecificOutput.permissionDecisionReason).toContain("in 1 seconds");
  });

  it("allows silently inside the window, leaving the marker alone", () => {
    run("PreToolUse", bash("gh issue list"));
    ageMarker(20);
    const before = statSync(marker()).mtimeMs;

    const { stdout, code } = run("PreToolUse", bash("gh issue list"));

    expect(stdout).toBe("");
    expect(code).toBe(0);
    expect(statSync(marker()).mtimeMs).toBe(before);
  });

  it("restarts the toll once the window has expired", () => {
    run("PreToolUse", bash("gh issue list"));
    ageMarker(40);
    const before = statSync(marker()).mtimeMs;

    const { json } = run("PreToolUse", bash("gh issue list"));

    expect(decision(json)).toBe("deny");
    expect(json?.hookSpecificOutput.permissionDecisionReason).toContain("in 15 seconds");
    expect(statSync(marker()).mtimeMs).toBeGreaterThan(before);
  });
});

describe("what is and is not guarded", () => {
  beforeEach(() => writeConfig());

  it.each([
    "gh issue view 42",
    "gh issue create --title x",
    "gh issue comment 42 --body x",
    "gh issue close 42",
    "gh pr list",
    "ls -la",
    "git log --oneline",
  ])("stays silent on %s", (command) => {
    expect(run("PreToolUse", bash(command)).stdout).toBe("");
  });

  it.each([
    'grep -rn "gh issue list" .claude/',
    "grep -rn 'gh issue list' .claude/",
    'echo "run gh issue list to see them"',
    'rg "glab issue list" docs/',
  ])("does not toll a guarded phrase quoted inside another command: %s", (command) => {
    // The phrase is being talked ABOUT, not run.
    expect(run("PreToolUse", bash(command)).stdout).toBe("");
  });

  it("still tolls when the guarded command itself carries a quoted argument", () => {
    expect(decision(run("PreToolUse", bash('gh issue list --search "crash on save"')).json)).toBe("deny");
  });

  it("still tolls a guarded command chained after another one", () => {
    expect(decision(run("PreToolUse", bash('echo "checking" && gh issue list')).json)).toBe("deny");
  });

  it("guards an MCP tool by name", () => {
    const { json } = run("PreToolUse", {
      hook_event_name: "PreToolUse",
      session_id: "s",
      cwd: INDEXED,
      tool_name: "mcp__gitlab__list_issues",
      tool_input: { project_id: 34 },
    });
    expect(decision(json)).toBe("deny");
  });

  it("leaves single-issue reads alone", () => {
    const { stdout } = run("PreToolUse", {
      hook_event_name: "PreToolUse",
      session_id: "s",
      tool_name: "mcp__gitlab__get_issue",
      tool_input: { issue_iid: 42 },
    });
    expect(stdout).toBe("");
  });
});

describe("configuration", () => {
  it("does nothing at all when disabled", () => {
    writeConfig({ enabled: false });
    expect(run("PreToolUse", bash("gh issue list")).stdout).toBe("");
  });

  it("frames an opt-in short wait as a speed bump, naming the way through", () => {
    writeConfig(TOLL_GUARD);
    const reason = run("PreToolUse", bash("gh issue list")).json?.hookSpecificOutput
      .permissionDecisionReason as string;
    expect(reason).toContain("not banned");
    expect(reason).toContain("15 seconds");
  });

  it("frames an opt-in long wait as a closed path, without leading with the workaround", () => {
    writeConfig({ ...TOLL_GUARD, lower_seconds: 3600, upper_seconds: 3900 });
    const reason = run("PreToolUse", bash("gh issue list")).json?.hookSpecificOutput
      .permissionDecisionReason as string;
    expect(reason).toContain("This path is closed");
    expect(reason).toContain("about 60 minutes");
    expect(reason).not.toContain("not banned");
    // The re-run recipe must not be the headline of a deliberately long wait.
    expect(reason).not.toContain("repeating it EXACTLY");
  });

  it("honours a longer grace period without a code change", () => {
    writeConfig({ ...TOLL_GUARD, lower_seconds: 5, upper_seconds: 300 });
    run("PreToolUse", bash("gh issue list"));
    ageMarker(280);
    expect(run("PreToolUse", bash("gh issue list")).stdout).toBe("");
  });

  it("appends extra_guards to the shipped list", () => {
    writeConfig({ extra_guards: [{ id: "rg", action: "toll", pattern: "\\brg\\b", hint: "search_code" }] });
    expect(decision(run("PreToolUse", bash("rg TODO src/")).json)).toBe("deny");
    // The shipped guards survive alongside it.
    rmSync(marker(), { force: true });
    expect(decision(run("PreToolUse", bash("gh issue list")).json)).toBe("deny");
  });

  it("lets guards replace the shipped list outright", () => {
    writeConfig({ guards: [{ id: "only-rg", action: "toll", pattern: "\\brg\\b" }] });
    expect(run("PreToolUse", bash("gh issue list")).stdout).toBe("");
  });

  it("ignores a guard whose regex does not compile, and keeps the rest working", () => {
    writeConfig({ extra_guards: [{ id: "broken", action: "toll", pattern: "([" }] });
    expect(decision(run("PreToolUse", bash("gh issue list")).json)).toBe("deny");
  });
});

describe("marker scope (toll action only)", () => {
  it("shares one window across sessions by default", () => {
    writeConfig(TOLL_GUARD);
    run("PreToolUse", bash("gh issue list", "session-a"));
    ageMarker(20);
    // Free-riding is the documented consequence of the global default.
    expect(run("PreToolUse", bash("gh issue list", "session-b")).stdout).toBe("");
  });

  it("gives each session its own window when scoped to the session", () => {
    writeConfig({ ...TOLL_GUARD, scope: "session" });
    run("PreToolUse", bash("gh issue list", "session-a"));
    ageMarker(20, "session-session-a");

    expect(run("PreToolUse", bash("gh issue list", "session-a")).stdout).toBe("");
    expect(decision(run("PreToolUse", bash("gh issue list", "session-b")).json)).toBe("deny");
  });

  it("pushes the expiry out on every allowed call when sliding", () => {
    writeConfig({ ...TOLL_GUARD, window: "sliding" });
    run("PreToolUse", bash("gh issue list"));
    ageMarker(20);

    expect(run("PreToolUse", bash("gh issue list")).stdout).toBe("");
    // Refreshed: the marker is young again, so the next call is back in the wait.
    expect(decision(run("PreToolUse", bash("gh issue list")).json)).toBe("deny");
  });
});

describe("note mode", () => {
  const noteConfig = {
    guards: [{ id: "gh-list", action: "note", pattern: "\\bgh\\s+issue\\s+list\\b", hint: "search_knowledge finds it" }],
  };

  it("does not block the call before it runs", () => {
    writeConfig(noteConfig);
    expect(run("PreToolUse", bash("gh issue list")).stdout).toBe("");
  });

  it("attaches context to the result afterwards", () => {
    writeConfig(noteConfig);
    const { json } = run("PostToolUse", {
      hook_event_name: "PostToolUse",
      session_id: "session-a",
      tool_name: "Bash",
      tool_input: { command: "gh issue list" },
      tool_response: { stdout: "" },
    });
    expect(json?.hookSpecificOutput.hookEventName).toBe("PostToolUse");
    expect(json?.hookSpecificOutput.additionalContext).toContain("search_knowledge");
    expect(json?.hookSpecificOutput.permissionDecision).toBeUndefined();
  });

  it("fires once per session, and again for a different session", () => {
    writeConfig(noteConfig);
    const post = (sessionId: string) =>
      run("PostToolUse", {
        hook_event_name: "PostToolUse",
        session_id: sessionId,
        tool_name: "Bash",
        tool_input: { command: "gh issue list" },
      });

    expect(post("session-a").stdout).not.toBe("");
    expect(post("session-a").stdout).toBe("");
    expect(post("session-b").stdout).not.toBe("");
  });

  it("says nothing after a tolled call", () => {
    writeConfig();
    const { stdout } = run("PostToolUse", {
      hook_event_name: "PostToolUse",
      session_id: "s",
      tool_name: "Bash",
      tool_input: { command: "gh issue list" },
    });
    expect(stdout).toBe("");
  });
});

describe("fails open", () => {
  it.each([
    ["malformed JSON", "not json at all"],
    ["empty stdin", ""],
    ["no tool_input", JSON.stringify({ hook_event_name: "PreToolUse", tool_name: "Bash" })],
    ["a non-string command", JSON.stringify({ tool_name: "Bash", tool_input: { command: 42 } })],
  ])("allows the call on %s", (_label, input) => {
    writeConfig();
    const { stdout, code } = run("PreToolUse", input);
    expect(stdout).toBe("");
    expect(code).toBe(0);
  });

  it("allows the call when the config file is unreadable", () => {
    writeFileSync(join(sandbox, "toll.json"), "{ broken");
    // Shipped defaults still apply, so the toll works; what must not happen is a crash.
    const { code } = run("PreToolUse", bash("gh issue list"));
    expect(code).toBe(0);
  });

  it("allows a tolled call when the marker cannot be written", () => {
    // Otherwise the wait could never end, and the toll would become a ban by accident.
    writeConfig({ ...TOLL_GUARD, marker_dir: join(sandbox, "does", "not", "exist") });
    const { stdout, code } = run("PreToolUse", bash("gh issue list"));
    expect(stdout).toBe("");
    expect(code).toBe(0);
  });

  it("still bans when the marker cannot be written", () => {
    // A ban keeps no state, so an unwritable filesystem cannot defeat it.
    writeConfig({ marker_dir: join(sandbox, "does", "not", "exist") });
    expect(decision(run("PreToolUse", bash("gh issue list")).json)).toBe("deny");
  });
});
