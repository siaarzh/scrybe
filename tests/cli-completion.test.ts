import { describe, it, expect } from "vitest";
import { spawnSync } from "child_process";
import { join } from "path";

const CLI = join(import.meta.dirname, "../dist/index.js");
const NODE = process.execPath;

function run(args: string[]): { stdout: string; stderr: string; status: number } {
  const result = spawnSync(NODE, [CLI, ...args], {
    encoding: "utf8",
    timeout: 10_000,
  });
  return {
    stdout: result.stdout ?? "",
    stderr: result.stderr ?? "",
    status: result.status ?? 1,
  };
}

describe("scrybe completion", () => {
  it("completion bash exits 0 with non-empty output", () => {
    const r = run(["completion", "bash"]);
    expect(r.status).toBe(0);
    expect(r.stdout.length).toBeGreaterThan(100);
  });

  it("completion bash output contains complete -F", () => {
    const r = run(["completion", "bash"]);
    expect(r.stdout).toContain("complete -F");
  });

  it("completion zsh exits 0 with non-empty output", () => {
    const r = run(["completion", "zsh"]);
    expect(r.status).toBe(0);
    expect(r.stdout.length).toBeGreaterThan(100);
  });

  it("completion zsh output contains #compdef scrybe", () => {
    const r = run(["completion", "zsh"]);
    expect(r.stdout).toContain("#compdef scrybe");
  });

  it("completion powershell exits 0 with non-empty output", () => {
    const r = run(["completion", "powershell"]);
    expect(r.status).toBe(0);
    expect(r.stdout.length).toBeGreaterThan(100);
  });

  it("completion powershell output contains Register-ArgumentCompleter", () => {
    const r = run(["completion", "powershell"]);
    expect(r.stdout).toContain("Register-ArgumentCompleter");
  });

  it("completion --help exits 0", () => {
    const r = run(["completion", "--help"]);
    expect(r.status).toBe(0);
  });

  it("completion with unknown shell exits 1", () => {
    const r = run(["completion", "fish"]);
    expect(r.status).toBe(1);
    expect(r.stderr).toContain("Unknown shell");
  });

  it("completion bash covers new noun-verb commands", () => {
    const r = run(["completion", "bash"]);
    expect(r.stdout).toContain("project");
    expect(r.stdout).toContain("source");
    expect(r.stdout).toContain("branch");
    expect(r.stdout).toContain("search");
  });
});
