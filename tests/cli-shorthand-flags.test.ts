import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { spawnSync } from "child_process";
import { join } from "path";
import { mkdtempSync, rmSync } from "fs";
import { tmpdir } from "os";

const CLI = join(import.meta.dirname, "../dist/index.js");
const NODE = process.execPath;

let dataDir = "";
beforeAll(() => { dataDir = mkdtempSync(join(tmpdir(), "scrybe-cli-sf-")); });
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

describe("Short flag -P (--project-id)", () => {
  it("-P recognized on status", () => {
    run(["project", "add", "--id", "sf-p-proj"]);
    const r = run(["status", "-P", "sf-p-proj"]);
    expect(r.stderr).not.toContain("unknown option");
    expect(r.status).toBe(0);
    run(["project", "remove", "--id", "sf-p-proj"]);
  });

  it("-P recognized on index (no unknown-option error)", () => {
    const r = run(["index", "-P", "no-such-proj"]);
    expect(r.stderr).not.toContain("unknown option");
  });
});

describe("Short flag -a (--all)", () => {
  it("index -a exits 0 with no projects", () => {
    const r = run(["index", "-a"]);
    expect(r.status).toBe(0);
    expect(r.stdout).toContain("No projects registered");
  });

  it("status -a recognized", () => {
    const r = run(["status", "-a"]);
    expect(r.stderr).not.toContain("unknown option");
    expect(r.status).toBe(0);
  });
});

describe("Short flag -y (--yes) on uninstall", () => {
  it("uninstall -y --dry-run exits 0 (nothing to uninstall)", () => {
    const r = run(["uninstall", "-y", "--dry-run"]);
    expect(r.stderr).not.toContain("unknown option");
    // With isolated empty data dir, shows "Nothing to uninstall"
    expect(r.status).toBe(0);
  });
});

describe("Short flag -p (--pinned) on branch list", () => {
  it("branch list -p recognized (no unknown-option error)", () => {
    run(["project", "add", "--id", "sf-branch-proj"]);
    run(["source", "add", "-P", "sf-branch-proj", "-S", "primary", "--type", "code", "--root", process.cwd()]);
    const r = run(["branch", "list", "-P", "sf-branch-proj", "-p"]);
    expect(r.stderr).not.toContain("unknown option");
    expect(r.status).toBe(0);
    run(["project", "remove", "--id", "sf-branch-proj"]);
  });
});

describe("Short flag -I (--incremental) on index", () => {
  it("-I recognized (no unknown-option error)", () => {
    const r = run(["index", "-P", "no-such-proj", "-I"]);
    expect(r.stderr).not.toContain("unknown option");
  });
});

describe("Short flag -f (--full) on index", () => {
  it("-f recognized (no unknown-option error)", () => {
    const r = run(["index", "-P", "no-such-proj", "-S", "primary", "-f"]);
    expect(r.stderr).not.toContain("unknown option");
  });
});

describe("Global plural shortcuts (no deprecation warning)", () => {
  it("projects exits 0 without warning", () => {
    const r = run(["projects"]);
    expect(r.stderr).not.toContain("[deprecated]");
    expect(r.status).toBe(0);
  });

  it("jobs exits 0 without warning", () => {
    const r = run(["jobs"]);
    expect(r.stderr).not.toContain("[deprecated]");
    expect(r.status).toBe(0);
  });

  it("sources exits 0 without warning", () => {
    const r = run(["sources"]);
    expect(r.stderr).not.toContain("[deprecated]");
    expect(r.status).toBe(0);
  });
});

describe("ps alias for status", () => {
  it("scrybe ps exits 0 without deprecation warning", () => {
    const r = run(["ps"]);
    expect(r.status).toBe(0);
    expect(r.stderr).not.toContain("[deprecated]");
  });

  it("scrybe ps and scrybe status produce same output", () => {
    const r1 = run(["ps"]);
    const r2 = run(["status"]);
    expect(r1.stdout).toBe(r2.stdout);
  });
});
