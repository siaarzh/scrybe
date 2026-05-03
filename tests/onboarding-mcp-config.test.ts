import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync, writeFileSync, readFileSync, existsSync, mkdirSync } from "fs";
import { join } from "path";
import { tmpdir } from "os";

// Module under test — imported fresh each test via dynamic import to pick up fs changes
async function load(_home: string) {
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
    const entry = { command: "npx", args: ["-y", "scrybe-cli@latest", "mcp"] };
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

  it("creates backup when modifying existing file", async () => {
    const { applyMcpMerge, computeDiff, detectMcpConfigs, proposeScrybeEntry } = await load(tmp);
    const { expectBackupCreated } = await import("./helpers/backup-contract.js");
    const claudeJson = join(tmp, ".claude.json");
    const old = { command: "node", args: ["/old/path/dist/index.js", "mcp"] };
    writeFileSync(claudeJson, JSON.stringify({ mcpServers: { scrybe: old } }));
    const file = detectMcpConfigs(tmp).find((r) => r.type === "claude-code")!;
    const proposed = proposeScrybeEntry({ binResolution: "npx" });
    const diff = computeDiff(file, proposed);
    await expectBackupCreated(claudeJson, () => applyMcpMerge(diff));
  });

  it("does not create backup when creating file for first time", async () => {
    const { applyMcpMerge, computeDiff, detectMcpConfigs, proposeScrybeEntry } = await load(tmp);
    const { expectNoBackupCreated } = await import("./helpers/backup-contract.js");
    const file = detectMcpConfigs(tmp).find((r) => r.type === "claude-code")!;
    const proposed = proposeScrybeEntry({ binResolution: "npx" });
    const diff = computeDiff(file, proposed);
    await expectNoBackupCreated(file.path, () => applyMcpMerge(diff));
  });
});

// ─── Codex (TOML) ────────────────────────────────────────────────────────────

describe("codex — TOML detection and read", () => {
  it("detects ~/.codex/config.toml path", async () => {
    const { detectMcpConfigs } = await load(tmp);
    const codex = detectMcpConfigs(tmp).find((r) => r.type === "codex")!;
    expect(codex.path).toContain("config.toml");
    expect(codex.exists).toBe(false);
  });

  it("reads scrybe entry from TOML", async () => {
    const { readScrybeEntry, detectMcpConfigs } = await load(tmp);
    const codexDir = join(tmp, ".codex");
    mkdirSync(codexDir, { recursive: true });
    writeFileSync(
      join(codexDir, "config.toml"),
      `[other]\nfoo = "bar"\n\n[mcp_servers.scrybe]\ncommand = "npx"\nargs = ["-y", "scrybe-cli@latest", "mcp"]\n`
    );
    const file = detectMcpConfigs(tmp).find((r) => r.type === "codex")!;
    const entry = readScrybeEntry(file);
    expect(entry).toEqual({ command: "npx", args: ["-y", "scrybe-cli@latest", "mcp"] });
  });

  it("returns null when [mcp_servers.scrybe] absent", async () => {
    const { readScrybeEntry, detectMcpConfigs } = await load(tmp);
    const codexDir = join(tmp, ".codex");
    mkdirSync(codexDir, { recursive: true });
    writeFileSync(join(codexDir, "config.toml"), `[other]\nfoo = "bar"\n`);
    const file = detectMcpConfigs(tmp).find((r) => r.type === "codex")!;
    expect(readScrybeEntry(file)).toBeNull();
  });
});

describe("codex — applyMcpMerge TOML", () => {
  it("writes new [mcp_servers.scrybe] block into empty file", async () => {
    const { applyMcpMerge, computeDiff, detectMcpConfigs, proposeScrybeEntry } = await load(tmp);
    const codexDir = join(tmp, ".codex");
    mkdirSync(codexDir, { recursive: true });
    const tomlPath = join(codexDir, "config.toml");
    writeFileSync(tomlPath, "");
    const file = detectMcpConfigs(tmp).find((r) => r.type === "codex")!;
    const proposed = proposeScrybeEntry({ binResolution: "npx" });
    await applyMcpMerge(computeDiff(file, proposed));
    const written = readFileSync(tomlPath, "utf8");
    expect(written).toContain("[mcp_servers.scrybe]");
    expect(written).toContain('command = "npx"');
    expect(written).toContain('args = ["-y", "scrybe-cli@latest", "mcp"]');
  });

  it("preserves other TOML tables when adding scrybe", async () => {
    const { applyMcpMerge, computeDiff, detectMcpConfigs, proposeScrybeEntry } = await load(tmp);
    const codexDir = join(tmp, ".codex");
    mkdirSync(codexDir, { recursive: true });
    const tomlPath = join(codexDir, "config.toml");
    writeFileSync(tomlPath, `[mcp_servers.other]\ncommand = "other"\nargs = []\n`);
    const file = detectMcpConfigs(tmp).find((r) => r.type === "codex")!;
    const proposed = proposeScrybeEntry({ binResolution: "npx" });
    await applyMcpMerge(computeDiff(file, proposed));
    const written = readFileSync(tomlPath, "utf8");
    expect(written).toContain("[mcp_servers.other]");
    expect(written).toContain("[mcp_servers.scrybe]");
  });

  it("replaces existing [mcp_servers.scrybe] block", async () => {
    const { applyMcpMerge, computeDiff, detectMcpConfigs, proposeScrybeEntry } = await load(tmp);
    const codexDir = join(tmp, ".codex");
    mkdirSync(codexDir, { recursive: true });
    const tomlPath = join(codexDir, "config.toml");
    writeFileSync(tomlPath, `[mcp_servers.scrybe]\ncommand = "old"\nargs = []\n`);
    const file = detectMcpConfigs(tmp).find((r) => r.type === "codex")!;
    const proposed = proposeScrybeEntry({ binResolution: "npx" });
    await applyMcpMerge(computeDiff(file, proposed));
    const written = readFileSync(tomlPath, "utf8");
    expect(written).toContain('command = "npx"');
    expect(written).not.toContain('command = "old"');
  });

  it("round-trips: read entry matches what was written", async () => {
    const { applyMcpMerge, computeDiff, detectMcpConfigs, proposeScrybeEntry, readScrybeEntry } = await load(tmp);
    const codexDir = join(tmp, ".codex");
    mkdirSync(codexDir, { recursive: true });
    const file = detectMcpConfigs(tmp).find((r) => r.type === "codex")!;
    const proposed = proposeScrybeEntry({ binResolution: "npx" });
    await applyMcpMerge(computeDiff(file, proposed));
    const read = readScrybeEntry({ ...file, exists: true });
    expect(read).toEqual(proposed);
  });
});

// ─── Cline + Roo Code (JSON via vsCodeGlobalStorageDir) ──────────────────────

describe("cline + roo-code detection", () => {
  it("detects cline and roo-code config paths under vscode-gs test dir", async () => {
    const { detectMcpConfigs } = await load(tmp);
    const results = detectMcpConfigs(tmp);
    const cline = results.find((r) => r.type === "cline")!;
    const roo = results.find((r) => r.type === "roo-code")!;
    expect(cline.path).toContain("cline_mcp_settings.json");
    expect(cline.path).toContain("saoudrizwan.claude-dev");
    expect(roo.path).toContain("mcp_settings.json");
    expect(roo.path).toContain("rooveterinaryinc.roo-cline");
    expect(cline.exists).toBe(false);
    expect(roo.exists).toBe(false);
  });

  it("reads and writes Cline entry exactly like claude-code (same JSON shape)", async () => {
    const { applyMcpMerge, computeDiff, detectMcpConfigs, proposeScrybeEntry, readScrybeEntry } = await load(tmp);
    const file = detectMcpConfigs(tmp).find((r) => r.type === "cline")!;
    const proposed = proposeScrybeEntry({ binResolution: "npx" });
    await applyMcpMerge(computeDiff(file, proposed));
    const written = JSON.parse(readFileSync(file.path, "utf8"));
    expect(written.mcpServers?.scrybe).toEqual(proposed);
    const read = readScrybeEntry({ ...file, exists: true });
    expect(read).toEqual(proposed);
  });
});

// ─── computeRemoveDiff ───────────────────────────────────────────────────────

describe("computeRemoveDiff", () => {
  it("action=skip when no scrybe entry present", async () => {
    const { computeRemoveDiff, detectMcpConfigs } = await load(tmp);
    writeFileSync(join(tmp, ".claude.json"), JSON.stringify({ mcpServers: { other: { command: "x", args: [] } } }));
    const file = detectMcpConfigs(tmp).find((r) => r.type === "claude-code")!;
    const diff = computeRemoveDiff(file);
    expect(diff.action).toBe("skip");
    expect(diff.existing).toBeNull();
  });

  it("action=skip when file missing", async () => {
    const { computeRemoveDiff, detectMcpConfigs } = await load(tmp);
    const file = detectMcpConfigs(tmp).find((r) => r.type === "claude-code")!;
    const diff = computeRemoveDiff(file);
    expect(diff.action).toBe("skip");
  });

  it("action=remove when scrybe entry present", async () => {
    const { computeRemoveDiff, detectMcpConfigs, proposeScrybeEntry } = await load(tmp);
    const proposed = proposeScrybeEntry({ binResolution: "npx" });
    writeFileSync(join(tmp, ".claude.json"), JSON.stringify({ mcpServers: { scrybe: proposed } }));
    const file = detectMcpConfigs(tmp).find((r) => r.type === "claude-code")!;
    const diff = computeRemoveDiff(file);
    expect(diff.action).toBe("remove");
    expect(diff.existing).toEqual(proposed);
  });
});

// ─── applyMcpRemove ──────────────────────────────────────────────────────────

describe("applyMcpRemove — JSON (claude-code)", () => {
  it("removes scrybe entry, preserves other entries, creates backup", async () => {
    const { applyMcpRemove, computeRemoveDiff, detectMcpConfigs, proposeScrybeEntry } = await load(tmp);
    const claudeJson = join(tmp, ".claude.json");
    const proposed = proposeScrybeEntry({ binResolution: "npx" });
    writeFileSync(claudeJson, JSON.stringify({ mcpServers: { scrybe: proposed, other: { command: "x", args: [] } } }));
    const file = detectMcpConfigs(tmp).find((r) => r.type === "claude-code")!;
    const diff = computeRemoveDiff(file);
    expect(diff.action).toBe("remove");
    await applyMcpRemove(diff);
    const written = JSON.parse(readFileSync(claudeJson, "utf8"));
    expect(written.mcpServers?.scrybe).toBeUndefined();
    expect(written.mcpServers?.other).toEqual({ command: "x", args: [] });
    // backup exists
    const { readdirSync } = await import("fs");
    const backups = readdirSync(tmp).filter((f) => f.includes(".scrybe-backup-"));
    expect(backups.length).toBeGreaterThan(0);
  });

  it("no-op on skip", async () => {
    const { applyMcpRemove, computeRemoveDiff, detectMcpConfigs } = await load(tmp);
    const claudeJson = join(tmp, ".claude.json");
    writeFileSync(claudeJson, JSON.stringify({ mcpServers: {} }));
    const before = readFileSync(claudeJson, "utf8");
    const file = detectMcpConfigs(tmp).find((r) => r.type === "claude-code")!;
    const diff = computeRemoveDiff(file);
    expect(diff.action).toBe("skip");
    await applyMcpRemove(diff);
    expect(readFileSync(claudeJson, "utf8")).toBe(before);
  });

  it("no-op if file deleted between compute and apply", async () => {
    const { applyMcpRemove, computeRemoveDiff, detectMcpConfigs, proposeScrybeEntry } = await load(tmp);
    const claudeJson = join(tmp, ".claude.json");
    const proposed = proposeScrybeEntry({ binResolution: "npx" });
    writeFileSync(claudeJson, JSON.stringify({ mcpServers: { scrybe: proposed } }));
    const file = detectMcpConfigs(tmp).find((r) => r.type === "claude-code")!;
    const diff = computeRemoveDiff(file);
    const { unlinkSync } = await import("fs");
    unlinkSync(claudeJson);
    await expect(applyMcpRemove(diff)).resolves.toBeUndefined();
  });
});

describe("applyMcpRemove — TOML (codex)", () => {
  it("removes [mcp_servers.scrybe] block, preserves other tables, creates backup", async () => {
    const { applyMcpRemove, computeRemoveDiff, detectMcpConfigs } = await load(tmp);
    const codexDir = join(tmp, ".codex");
    mkdirSync(codexDir, { recursive: true });
    const tomlPath = join(codexDir, "config.toml");
    writeFileSync(tomlPath, `[mcp_servers.other]\ncommand = "other"\nargs = []\n\n[mcp_servers.scrybe]\ncommand = "npx"\nargs = ["-y", "scrybe-cli@latest", "mcp"]\n`);
    const file = detectMcpConfigs(tmp).find((r) => r.type === "codex")!;
    const diff = computeRemoveDiff(file);
    expect(diff.action).toBe("remove");
    await applyMcpRemove(diff);
    const written = readFileSync(tomlPath, "utf8");
    expect(written).not.toContain("[mcp_servers.scrybe]");
    expect(written).toContain("[mcp_servers.other]");
    // backup exists
    const { readdirSync } = await import("fs");
    const backups = readdirSync(codexDir).filter((f) => f.includes(".scrybe-backup-"));
    expect(backups.length).toBeGreaterThan(0);
  });
});
