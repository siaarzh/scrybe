import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync, statSync, utimesSync, writeFileSync } from "node:fs";
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
  writeFileSync(
    join(sandbox, "toll.json"),
    JSON.stringify({ marker_dir: sandbox, ...overrides })
  );
}

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

function bash(command: string, sessionId = "session-a") {
  return { hook_event_name: "PreToolUse", session_id: sessionId, tool_name: "Bash", tool_input: { command } };
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

describe("toll state machine", () => {
  beforeEach(() => writeConfig());

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

  it("tolls a guarded MCP tool by name", () => {
    const { json } = run("PreToolUse", {
      hook_event_name: "PreToolUse",
      session_id: "s",
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

  it("honours a longer grace period without a code change", () => {
    writeConfig({ lower_seconds: 5, upper_seconds: 300 });
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

describe("marker scope", () => {
  it("shares one window across sessions by default", () => {
    writeConfig();
    run("PreToolUse", bash("gh issue list", "session-a"));
    ageMarker(20);
    // Free-riding is the documented consequence of the global default.
    expect(run("PreToolUse", bash("gh issue list", "session-b")).stdout).toBe("");
  });

  it("gives each session its own window when scoped to the session", () => {
    writeConfig({ scope: "session" });
    run("PreToolUse", bash("gh issue list", "session-a"));
    ageMarker(20, "session-session-a");

    expect(run("PreToolUse", bash("gh issue list", "session-a")).stdout).toBe("");
    expect(decision(run("PreToolUse", bash("gh issue list", "session-b")).json)).toBe("deny");
  });

  it("pushes the expiry out on every allowed call when sliding", () => {
    writeConfig({ window: "sliding" });
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

  it("allows the call when the marker cannot be written", () => {
    writeConfig({ marker_dir: join(sandbox, "does", "not", "exist") });
    const { stdout, code } = run("PreToolUse", bash("gh issue list"));
    expect(stdout).toBe("");
    expect(code).toBe(0);
  });
});
