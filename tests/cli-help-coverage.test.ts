import { describe, it, expect } from "vitest";
import { spawnSync } from "child_process";
import { join } from "path";

const CLI = join(import.meta.dirname, "../dist/index.js");
const NODE = process.execPath;

function help(args: string[]): { stdout: string; status: number } {
  const result = spawnSync(NODE, [CLI, ...args, "--help"], {
    encoding: "utf8",
    timeout: 10_000,
  });
  return { stdout: result.stdout ?? "", status: result.status ?? 1 };
}

describe("per-command --help quality", () => {
  const commands = [
    ["project"],
    ["project", "add"],
    ["project", "update"],
    ["project", "remove"],
    ["project", "list"],
    ["source"],
    ["source", "add"],
    ["source", "update"],
    ["source", "remove"],
    ["source", "list"],
    ["search"],
    ["search", "code"],
    ["search", "knowledge"],
    ["job"],
    ["job", "list"],
    ["branch"],
    ["branch", "list"],
    ["branch", "pin"],
    ["branch", "unpin"],
    ["index"],
    ["gc"],
    ["daemon"],
    ["daemon", "start"],
    ["daemon", "stop"],
    ["daemon", "restart"],
    ["daemon", "refresh"],
    ["daemon", "install"],
    ["daemon", "uninstall"],
    ["hook"],
    ["hook", "install"],
    ["hook", "uninstall"],
    ["init"],
    ["doctor"],
    ["status"],
    ["uninstall"],
  ];

  for (const args of commands) {
    it(`${args.join(" ")} --help exits 0`, () => {
      const { status } = help(args);
      expect(status).toBe(0);
    });

    it(`${args.join(" ")} --help includes description`, () => {
      const { stdout } = help(args);
      expect(stdout.length).toBeGreaterThan(50);
    });
  }
});

describe("noun group --help lists verbs", () => {
  it("project --help lists add/update/remove/list", () => {
    const { stdout } = help(["project"]);
    expect(stdout).toContain("add");
    expect(stdout).toContain("update");
    expect(stdout).toContain("remove");
    expect(stdout).toContain("list");
  });

  it("source --help lists add/update/remove/list", () => {
    const { stdout } = help(["source"]);
    expect(stdout).toContain("add");
    expect(stdout).toContain("update");
    expect(stdout).toContain("remove");
    expect(stdout).toContain("list");
  });

  it("search --help lists code/knowledge", () => {
    const { stdout } = help(["search"]);
    expect(stdout).toContain("code");
    expect(stdout).toContain("knowledge");
  });

  it("branch --help lists list/pin/unpin", () => {
    const { stdout } = help(["branch"]);
    expect(stdout).toContain("list");
    expect(stdout).toContain("pin");
    expect(stdout).toContain("unpin");
  });

  it("daemon --help lists start/stop/restart/refresh", () => {
    const { stdout } = help(["daemon"]);
    expect(stdout).toContain("start");
    expect(stdout).toContain("stop");
    expect(stdout).toContain("restart");
    expect(stdout).toContain("refresh");
  });

  it("top-level --help lists canonical noun groups", () => {
    const { stdout } = help([]);
    expect(stdout).toContain("project");
    expect(stdout).toContain("source");
    expect(stdout).toContain("search");
    expect(stdout).toContain("branch");
    expect(stdout).toContain("daemon");
    expect(stdout).toContain("index");
    expect(stdout).toContain("status");
  });
});

describe("commands with examples in --help", () => {
  const commandsWithExamples = [
    ["project", "add"],
    ["source", "add"],
    ["search", "code"],
    ["search", "knowledge"],
    ["index"],
    ["branch", "pin"],
    ["branch", "unpin"],
    ["hook", "install"],
    ["daemon", "refresh"],
  ];

  for (const args of commandsWithExamples) {
    it(`${args.join(" ")} --help contains example`, () => {
      const { stdout } = help(args);
      expect(stdout).toContain("Example");
    });
  }
});
