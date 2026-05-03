import { existsSync, readFileSync, writeFileSync, mkdirSync, renameSync, unlinkSync } from "fs";
import { join, dirname } from "path";
import { homedir } from "os";
import { randomBytes } from "crypto";
import { createBackup } from "../util/backup.js";

export type McpClientType = "claude-code" | "cursor" | "codex" | "cline" | "roo-code";

export interface McpConfigFile {
  type: McpClientType;
  path: string;
  exists: boolean;
}

export interface ScrybeMcpEntry {
  command: string;
  args: string[];
  env?: Record<string, string>;
}

export interface McpEntryDiff {
  file: McpConfigFile;
  existing: ScrybeMcpEntry | null;
  proposed: ScrybeMcpEntry;
  /** "add" = no current scrybe entry; "replace" = entry differs; "skip" = identical */
  action: "add" | "replace" | "skip";
  diff: string;
}

export interface RemoveDiff {
  file: McpConfigFile;
  existing: ScrybeMcpEntry | null;
  action: "remove" | "skip";
  diff: string;
}

// ─── Path helpers ─────────────────────────────────────────────────────────────

/**
 * Returns the VS Code User globalStorage base dir.
 * When `home` is provided (test mode), fakes it under `home/.vscode-gs/`.
 */
function vsCodeGlobalStorageDir(home?: string): string {
  if (home) return join(home, ".vscode-gs");
  const h = homedir();
  if (process.platform === "win32") {
    const appData = process.env.APPDATA ?? join(h, "AppData", "Roaming");
    return join(appData, "Code", "User", "globalStorage");
  }
  if (process.platform === "darwin") {
    return join(h, "Library", "Application Support", "Code", "User", "globalStorage");
  }
  return join(process.env.XDG_CONFIG_HOME ?? join(h, ".config"), "Code", "User", "globalStorage");
}

// ─── Exports ──────────────────────────────────────────────────────────────────

export function detectMcpConfigs(home?: string): McpConfigFile[] {
  const h = home ?? homedir();
  const gsDir = vsCodeGlobalStorageDir(home);
  const candidates: { type: McpClientType; path: string }[] = [
    { type: "claude-code", path: join(h, ".claude.json") },
    { type: "cursor",      path: join(h, ".cursor", "mcp.json") },
    { type: "codex",       path: join(h, ".codex", "config.toml") },
    {
      type: "cline",
      path: join(gsDir, "saoudrizwan.claude-dev", "settings", "cline_mcp_settings.json"),
    },
    {
      type: "roo-code",
      path: join(gsDir, "rooveterinaryinc.roo-cline", "settings", "mcp_settings.json"),
    },
  ];
  return candidates.map(({ type, path }) => ({ type, path, exists: existsSync(path) }));
}

export function readScrybeEntry(file: McpConfigFile): ScrybeMcpEntry | null {
  if (!file.exists) return null;
  if (file.type === "codex") return readTomlScrybeEntry(file.path);
  return readJsonScrybeEntry(file.path);
}

export function proposeScrybeEntry(opts: { binResolution: "npx" | "local"; localPath?: string }): ScrybeMcpEntry {
  if (opts.binResolution === "npx") {
    return { command: "npx", args: ["-y", "scrybe-cli@latest", "mcp"] };
  }
  if (!opts.localPath) throw new Error("localPath required for binResolution='local'");
  return { command: process.execPath, args: [opts.localPath, "mcp"] };
}

export function computeDiff(file: McpConfigFile, proposed: ScrybeMcpEntry): McpEntryDiff {
  const existing = readScrybeEntry(file);
  const isToml = file.type === "codex";

  const existingStr = existing
    ? (isToml ? serializeTomlEntry(existing) : JSON.stringify(existing, null, 2))
    : null;
  const proposedStr = isToml ? serializeTomlEntry(proposed) : JSON.stringify(proposed, null, 2);

  let action: McpEntryDiff["action"];
  let diff: string;

  if (!existing) {
    action = "add";
    diff = isToml
      ? `+ [mcp_servers.scrybe]\n${proposedStr}`
      : `+ "scrybe": ${proposedStr}`;
  } else if (existingStr === proposedStr) {
    action = "skip";
    diff = isToml
      ? `  [mcp_servers.scrybe]\n${proposedStr}  (no change)`
      : `  "scrybe": ${proposedStr}  (no change)`;
  } else {
    action = "replace";
    const oldLines = existingStr!.split("\n").map((l) => `- ${l}`).join("\n");
    const newLines = proposedStr.split("\n").map((l) => `+ ${l}`).join("\n");
    diff = `${oldLines}\n${newLines}`;
  }

  return { file, existing, proposed, action, diff };
}

export async function applyMcpMerge(diff: McpEntryDiff): Promise<void> {
  if (diff.action === "skip") return;

  const { path, type } = diff.file;
  const dir = dirname(path);
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });

  if (existsSync(path)) createBackup(path);

  if (type === "codex") {
    await applyTomlMerge(path, diff.proposed);
  } else {
    await applyJsonMerge(path, diff.proposed);
  }
}

export function computeRemoveDiff(file: McpConfigFile): RemoveDiff {
  const existing = readScrybeEntry(file);
  if (!existing) {
    return { file, existing: null, action: "skip", diff: "(no scrybe entry present)" };
  }
  const isToml = file.type === "codex";
  const existingStr = isToml ? serializeTomlEntry(existing) : JSON.stringify(existing, null, 2);
  const diffLines = existingStr.split("\n").map((l) => `- ${l}`).join("\n");
  const diff = isToml
    ? `- [mcp_servers.scrybe]\n${diffLines}`
    : `- "scrybe": ${diffLines}`;
  return { file, existing, action: "remove", diff };
}

export async function applyMcpRemove(diff: RemoveDiff): Promise<void> {
  if (diff.action === "skip") return;
  const { path, type } = diff.file;
  if (!existsSync(path)) {
    console.warn(`[scrybe] applyMcpRemove: file no longer exists: ${path}`);
    return;
  }
  createBackup(path);
  if (type === "codex") {
    applyTomlRemove(path);
  } else {
    applyJsonRemove(path);
  }
}

// ─── JSON helpers (claude-code, cursor, cline, roo-code) ──────────────────────

function readJsonScrybeEntry(path: string): ScrybeMcpEntry | null {
  let raw: unknown;
  try {
    raw = JSON.parse(readFileSync(path, "utf8"));
  } catch {
    return null;
  }
  const servers = (raw as any)?.mcpServers as Record<string, unknown> | undefined;
  if (!servers || typeof servers !== "object") return null;
  const entry = servers["scrybe"] as any;
  if (!entry || typeof entry.command !== "string" || !Array.isArray(entry.args)) return null;
  const result: ScrybeMcpEntry = { command: entry.command, args: entry.args };
  if (entry.env && typeof entry.env === "object") result.env = entry.env;
  return result;
}

async function applyJsonMerge(path: string, proposed: ScrybeMcpEntry): Promise<void> {
  let raw: Record<string, unknown> = {};
  if (existsSync(path)) {
    try {
      raw = JSON.parse(readFileSync(path, "utf8")) as Record<string, unknown>;
    } catch {
      const backupPath = `${path}.bak-${Date.now()}`;
      writeFileSync(backupPath, readFileSync(path));
      raw = {};
    }
  }

  if (!raw["mcpServers"] || typeof raw["mcpServers"] !== "object") {
    raw["mcpServers"] = {};
  }
  (raw["mcpServers"] as Record<string, unknown>)["scrybe"] = proposed;

  atomicWrite(path, JSON.stringify(raw, null, 2) + "\n");
}

// ─── TOML helpers (codex) ─────────────────────────────────────────────────────

function readTomlScrybeEntry(path: string): ScrybeMcpEntry | null {
  let toml: string;
  try {
    toml = readFileSync(path, "utf8");
  } catch {
    return null;
  }

  // Match [mcp_servers.scrybe] table block (up to next table header or end of file)
  const match = toml.match(/\[mcp_servers\.scrybe\]([\s\S]*?)(?=\n\s*\[|$)/);
  if (!match) return null;
  const block = match[1];

  const cmdMatch = block.match(/^\s*command\s*=\s*"([^"]*)"\s*$/m);
  if (!cmdMatch) return null;
  const command = cmdMatch[1];

  const args: string[] = [];
  const argsMatch = block.match(/^\s*args\s*=\s*\[([^\]]*)\]\s*$/m);
  if (argsMatch) {
    for (const m of argsMatch[1].matchAll(/"([^"]*)"/g)) {
      args.push(m[1]);
    }
  }

  return { command, args };
}

/** Serializes a ScrybeMcpEntry to the body lines of a TOML [mcp_servers.scrybe] block (no header). */
function serializeTomlEntry(entry: ScrybeMcpEntry): string {
  const argsToml = "[" + entry.args.map((a) => `"${a}"`).join(", ") + "]";
  return `command = "${entry.command}"\nargs = ${argsToml}`;
}

async function applyTomlMerge(path: string, proposed: ScrybeMcpEntry): Promise<void> {
  let existing = "";
  if (existsSync(path)) {
    try {
      existing = readFileSync(path, "utf8");
    } catch { /* start fresh */ }
  }

  const header = "[mcp_servers.scrybe]";
  const body = serializeTomlEntry(proposed);
  const block = `${header}\n${body}`;

  // Replace existing section (up to next table or end of file)
  const sectionRe = /\[mcp_servers\.scrybe\][\s\S]*?(?=\n\s*\[|\n*$)/;
  let updated: string;
  if (sectionRe.test(existing)) {
    updated = existing.replace(sectionRe, block);
  } else {
    updated = existing.trimEnd() + (existing.length > 0 ? "\n\n" : "") + block + "\n";
  }

  atomicWrite(path, updated);
}

function applyJsonRemove(path: string): void {
  let raw: Record<string, unknown> = {};
  try {
    raw = JSON.parse(readFileSync(path, "utf8")) as Record<string, unknown>;
  } catch {
    return;
  }
  if (raw["mcpServers"] && typeof raw["mcpServers"] === "object") {
    delete (raw["mcpServers"] as Record<string, unknown>)["scrybe"];
  }
  atomicWrite(path, JSON.stringify(raw, null, 2) + "\n");
}

function applyTomlRemove(path: string): void {
  let existing = "";
  try {
    existing = readFileSync(path, "utf8");
  } catch {
    return;
  }
  // Remove [mcp_servers.scrybe] block, including any preceding blank lines
  const sectionRe = /\n*\[mcp_servers\.scrybe\][\s\S]*?(?=\n\s*\[|\n*$)/;
  const updated = existing.replace(sectionRe, "").replace(/\n{3,}/g, "\n\n");
  atomicWrite(path, updated || "");
}

// ─── Shared ───────────────────────────────────────────────────────────────────

function atomicWrite(path: string, content: string): void {
  const tmp = `${path}.tmp-${randomBytes(4).toString("hex")}`;
  writeFileSync(tmp, content, "utf8");
  try {
    renameSync(tmp, path);
  } catch {
    try { unlinkSync(path); } catch { /* ignore */ }
    renameSync(tmp, path);
  }
}
