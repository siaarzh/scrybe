import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { spawnSync } from "child_process";
import { join } from "path";
import { mkdtempSync, rmSync } from "fs";
import { tmpdir } from "os";

const CLI = join(import.meta.dirname, "../dist/index.js");
const NODE = process.execPath;

let dataDir = "";
beforeAll(() => { dataDir = mkdtempSync(join(tmpdir(), "scrybe-cli-dep-")); });
afterAll(() => { try { rmSync(dataDir, { recursive: true, force: true }); } catch { /* ignore */ } });

function run(args: string[], extraEnv: Record<string, string> = {}): { stdout: string; stderr: string; status: number } {
  const result = spawnSync(NODE, [CLI, ...args], {
    env: { ...process.env, SCRYBE_DATA_DIR: dataDir, ...extraEnv },
    encoding: "utf8",
    timeout: 15_000,
  });
  return {
    stdout: result.stdout ?? "",
    stderr: result.stderr ?? "",
    status: result.status ?? 1,
  };
}

describe("CLI deprecation warnings printed to stderr", () => {
  it("add-project: warning + canonical command runs + exit 0", () => {
    const r = run(["add-project", "--id", "dep-test-proj"]);
    expect(r.stderr).toContain("[deprecated]");
    expect(r.stderr).toContain("add-project");
    expect(r.stderr).toContain("project add");
    expect(r.stdout).toContain("Added project");
    expect(r.status).toBe(0);
    run(["project", "remove", "--id", "dep-test-proj"]);
  });

  it("update-project: warning + canonical command runs", () => {
    run(["project", "add", "--id", "dep-upd-proj"]);
    const r = run(["update-project", "--id", "dep-upd-proj", "--desc", "new desc"]);
    expect(r.stderr).toContain("[deprecated]");
    expect(r.stderr).toContain("update-project");
    expect(r.stderr).toContain("project update");
    expect(r.status).toBe(0);
    run(["project", "remove", "--id", "dep-upd-proj"]);
  });

  it("remove-project: warning + canonical command runs", () => {
    run(["project", "add", "--id", "dep-rm-proj"]);
    const r = run(["remove-project", "--id", "dep-rm-proj"]);
    expect(r.stderr).toContain("[deprecated]");
    expect(r.stderr).toContain("remove-project");
    expect(r.stderr).toContain("project remove");
    expect(r.status).toBe(0);
  });

  it("list-projects: warning + canonical command runs + exit 0", () => {
    const r = run(["list-projects"]);
    expect(r.stderr).toContain("[deprecated]");
    expect(r.stderr).toContain("list-projects");
    expect(r.stderr).toContain("project list");
    expect(r.status).toBe(0);
  });

  it("search-knowledge: warning printed to stderr", () => {
    const r = run(["search-knowledge", "--project-id", "no-such-project", "query"]);
    expect(r.stderr).toContain("[deprecated]");
    expect(r.stderr).toContain("search-knowledge");
    expect(r.stderr).toContain("search knowledge");
    // May fail due to missing project/embedding — just check warning emitted before error
  });

  it("pin list: warning + exit 0 when source exists", () => {
    run(["project", "add", "--id", "dep-pin-proj"]);
    run(["source", "add", "-P", "dep-pin-proj", "-S", "primary", "--type", "code", "--root", process.cwd()]);
    const r = run(["pin", "list", "--project-id", "dep-pin-proj"]);
    expect(r.stderr).toContain("[deprecated]");
    expect(r.stderr).toContain("pin list");
    expect(r.stderr).toContain("branch list --pinned");
    expect(r.status).toBe(0);
    run(["project", "remove", "--id", "dep-pin-proj"]);
  });

  it("daemon kick: warning printed even when daemon not running", () => {
    const r = run(["daemon", "kick"]);
    expect(r.stderr).toContain("[deprecated]");
    expect(r.stderr).toContain("daemon kick");
    expect(r.stderr).toContain("daemon refresh");
    // Exits non-zero (daemon not running) — warning still emitted first
  });

  it("pin add: warning printed", () => {
    run(["project", "add", "--id", "dep-pinadd-proj"]);
    run(["source", "add", "-P", "dep-pinadd-proj", "-S", "primary", "--type", "code", "--root", process.cwd()]);
    const r = run(["pin", "add", "--project-id", "dep-pinadd-proj", "feature/test"]);
    expect(r.stderr).toContain("[deprecated]");
    expect(r.stderr).toContain("pin add");
    expect(r.stderr).toContain("branch pin");
    run(["project", "remove", "--id", "dep-pinadd-proj"]);
  });

  it("pin remove: warning printed", () => {
    run(["project", "add", "--id", "dep-pinrm-proj"]);
    run(["source", "add", "-P", "dep-pinrm-proj", "-S", "primary", "--type", "code", "--root", process.cwd()]);
    const r = run(["pin", "remove", "--project-id", "dep-pinrm-proj", "feature/test"]);
    expect(r.stderr).toContain("[deprecated]");
    expect(r.stderr).toContain("pin remove");
    expect(r.stderr).toContain("branch unpin");
    run(["project", "remove", "--id", "dep-pinrm-proj"]);
  });

  it("pin clear: warning printed", () => {
    run(["project", "add", "--id", "dep-pincl-proj"]);
    run(["source", "add", "-P", "dep-pincl-proj", "-S", "primary", "--type", "code", "--root", process.cwd()]);
    const r = run(["pin", "clear", "--project-id", "dep-pincl-proj", "--yes"]);
    expect(r.stderr).toContain("[deprecated]");
    expect(r.stderr).toContain("pin clear");
    expect(r.stderr).toContain("branch unpin --all");
    run(["project", "remove", "--id", "dep-pincl-proj"]);
  });
});

describe("SCRYBE_NO_DEPRECATION_WARNING=1 suppresses warning", () => {
  it("list-projects without warning when env var set", () => {
    const r = run(["list-projects"], { SCRYBE_NO_DEPRECATION_WARNING: "1" });
    expect(r.stderr).not.toContain("[deprecated]");
    expect(r.status).toBe(0);
  });

  it("add-project without warning when env var set", () => {
    const r = run(["add-project", "--id", "dep-nowarning-proj"], { SCRYBE_NO_DEPRECATION_WARNING: "1" });
    expect(r.stderr).not.toContain("[deprecated]");
    expect(r.status).toBe(0);
    run(["project", "remove", "--id", "dep-nowarning-proj"]);
  });
});

describe("CLI deprecated aliases hidden from help", () => {
  it("add-project not in scrybe --help", () => {
    const r = run(["--help"]);
    expect(r.stdout).not.toContain("add-project");
  });

  it("list-projects not in scrybe --help", () => {
    const r = run(["--help"]);
    expect(r.stdout).not.toContain("list-projects");
  });

  it("search-knowledge not in scrybe --help", () => {
    const r = run(["--help"]);
    expect(r.stdout).not.toContain("search-knowledge");
  });

  it("pin not in scrybe --help", () => {
    const r = run(["--help"]);
    // "pin" should not appear as a command name (but may appear in description text)
    expect(r.stdout).not.toMatch(/^  pin\s/m);
  });

  it("daemon kick not in daemon --help", () => {
    const r = run(["daemon", "--help"]);
    expect(r.stdout).not.toContain("kick");
  });
});
