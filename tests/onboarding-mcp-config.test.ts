import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync, writeFileSync, readFileSync, existsSync, mkdirSync } from "fs";
import { join } from "path";
import { tmpdir } from "os";

// Module under test — imported fresh each test via dynamic import to pick up fs changes
async function load(home: string) {
  // Provide a home-scoped version of detectMcpConfigs
  const m = await import("../src/onboarding/mcp-config.js");
  return m;
}

let tmp = "";

beforeEach(() => {
  tmp = mkdtempSync(join(tmpdir(), "scrybe-mcp-test-"));
});

afterEach(() => {
  rmSync(tmp, { recursive: true, force: true });
});

describe("detectMcpConfigs", () => {
  it("marks files that exist", async () => {
    const { detectMcpConfigs } = await load(tmp);
    const claudeJson = join(tmp, ".claude.json");
    writeFileSync(claudeJson, "{}");
    const results = detectMcpConfigs(tmp);
    const claude = results.find((r) => r.type === "claude-code")!;
    expect(claude.exists).toBe(true);
    expect(claude.path).toBe(claudeJson);
    const cursor = results.find((r) => r.type === "cursor")!;
    expect(cursor.exists).toBe(false);
  });

  it("marks files that don't exist", async () => {
    const { detectMcpConfigs } = await load(tmp);
    const results = detectMcpConfigs(tmp);
    expect(results.every((r) => !r.exists)).toBe(true);
  });
});

describe("readScrybeEntry", () => {
  it("returns null when file missing", async () => {
    const { readScrybeEntry, detectMcpConfigs } = await load(tmp);
    const [file] = detectMcpConfigs(tmp);
    expect(readScrybeEntry(file!)).toBeNull();
  });

  it("returns null when scrybe entry absent", async () => {
    const { readScrybeEntry, detectMcpConfigs } = await load(tmp);
    writeFileSync(join(tmp, ".claude.json"), JSON.stringify({ mcpServers: { other: { command: "x", args: [] } } }));
    const file = detectMcpConfigs(tmp).find((r) => r.type === "claude-code")!;
    expect(readScrybeEntry(file)).toBeNull();
  });

  it("reads existing scrybe entry", async () => {
    const { readScrybeEntry, detectMcpConfigs } = await load(tmp);
    const entry = { command: "npx", args: ["-y", "scrybe-cli", "mcp"] };
    writeFileSync(join(tmp, ".claude.json"), JSON.stringify({ mcpServers: { scrybe: entry } }));
    const file = detectMcpConfigs(tmp).find((r) => r.type === "claude-code")!;
    expect(readScrybeEntry(file)).toEqual(entry);
  });

  it("returns null on corrupt JSON", async () => {
    const { readScrybeEntry, detectMcpConfigs } = await load(tmp);
    writeFileSync(join(tmp, ".claude.json"), "{ bad json");
    const file = detectMcpConfigs(tmp).find((r) => r.type === "claude-code")!;
    expect(readScrybeEntry(file)).toBeNull();
  });
});

describe("computeDiff", () => {
  it("action=add when no existing entry", async () => {
    const { computeDiff, detectMcpConfigs, proposeScrybeEntry } = await load(tmp);
    writeFileSync(join(tmp, ".claude.json"), "{}");
    const file = detectMcpConfigs(tmp).find((r) => r.type === "claude-code")!;
    const proposed = proposeScrybeEntry({ binResolution: "npx" });
    const diff = computeDiff(file, proposed);
    expect(diff.action).toBe("add");
    expect(diff.existing).toBeNull();
  });

  it("action=skip when entry matches", async () => {
    const { computeDiff, detectMcpConfigs, proposeScrybeEntry } = await load(tmp);
    const proposed = proposeScrybeEntry({ binResolution: "npx" });
    writeFileSync(join(tmp, ".claude.json"), JSON.stringify({ mcpServers: { scrybe: proposed } }));
    const file = detectMcpConfigs(tmp).find((r) => r.type === "claude-code")!;
    const diff = computeDiff(file, proposed);
    expect(diff.action).toBe("skip");
  });

  it("action=replace when entry differs", async () => {
    const { computeDiff, detectMcpConfigs, proposeScrybeEntry } = await load(tmp);
    const old = { command: "node", args: ["/old/path/dist/index.js", "mcp"] };
    writeFileSync(join(tmp, ".claude.json"), JSON.stringify({ mcpServers: { scrybe: old } }));
    const file = detectMcpConfigs(tmp).find((r) => r.type === "claude-code")!;
    const proposed = proposeScrybeEntry({ binResolution: "npx" });
    const diff = computeDiff(file, proposed);
    expect(diff.action).toBe("replace");
    expect(diff.existing).toEqual(old);
  });
});

describe("applyMcpMerge", () => {
  it("writes new entry into empty file", async () => {
    const { applyMcpMerge, computeDiff, detectMcpConfigs, proposeScrybeEntry } = await load(tmp);
    const claudeJson = join(tmp, ".claude.json");
    writeFileSync(claudeJson, "{}");
    const file = detectMcpConfigs(tmp).find((r) => r.type === "claude-code")!;
    const proposed = proposeScrybeEntry({ binResolution: "npx" });
    await applyMcpMerge(computeDiff(file, proposed));
    const written = JSON.parse(readFileSync(claudeJson, "utf8"));
    expect(written.mcpServers?.scrybe).toEqual(proposed);
  });

  it("creates file when missing", async () => {
    const { applyMcpMerge, computeDiff, detectMcpConfigs, proposeScrybeEntry } = await load(tmp);
    const file = detectMcpConfigs(tmp).find((r) => r.type === "claude-code")!;
    const proposed = proposeScrybeEntry({ binResolution: "npx" });
    await applyMcpMerge(computeDiff(file, proposed));
    expect(existsSync(file.path)).toBe(true);
    const written = JSON.parse(readFileSync(file.path, "utf8"));
    expect(written.mcpServers?.scrybe).toEqual(proposed);
  });

  it("preserves other mcpServers entries", async () => {
    const { applyMcpMerge, computeDiff, detectMcpConfigs, proposeScrybeEntry } = await load(tmp);
    const claudeJson = join(tmp, ".claude.json");
    writeFileSync(claudeJson, JSON.stringify({ mcpServers: { other: { command: "x", args: [] } } }));
    const file = detectMcpConfigs(tmp).find((r) => r.type === "claude-code")!;
    const proposed = proposeScrybeEntry({ binResolution: "npx" });
    await applyMcpMerge(computeDiff(file, proposed));
    const written = JSON.parse(readFileSync(claudeJson, "utf8"));
    expect(written.mcpServers?.other).toEqual({ command: "x", args: [] });
    expect(written.mcpServers?.scrybe).toEqual(proposed);
  });

  it("no-ops on skip", async () => {
    const { applyMcpMerge, computeDiff, detectMcpConfigs, proposeScrybeEntry } = await load(tmp);
    const proposed = proposeScrybeEntry({ binResolution: "npx" });
    const claudeJson = join(tmp, ".claude.json");
    writeFileSync(claudeJson, JSON.stringify({ mcpServers: { scrybe: proposed } }));
    const before = readFileSync(claudeJson, "utf8");
    const file = detectMcpConfigs(tmp).find((r) => r.type === "claude-code")!;
    await applyMcpMerge(computeDiff(file, proposed));
    expect(readFileSync(claudeJson, "utf8")).toBe(before);
  });

  it("creates cursor directory if missing", async () => {
    const { applyMcpMerge, computeDiff, detectMcpConfigs, proposeScrybeEntry } = await load(tmp);
    const file = detectMcpConfigs(tmp).find((r) => r.type === "cursor")!;
    const proposed = proposeScrybeEntry({ binResolution: "npx" });
    await applyMcpMerge(computeDiff(file, proposed));
    expect(existsSync(file.path)).toBe(true);
  });
});
