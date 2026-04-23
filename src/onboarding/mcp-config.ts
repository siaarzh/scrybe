import { existsSync, readFileSync, writeFileSync, mkdirSync, renameSync, unlinkSync } from "fs";
import { join, dirname } from "path";
import { homedir } from "os";
import { randomBytes } from "crypto";

export type McpClientType = "claude-code" | "cursor";

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

export function detectMcpConfigs(home?: string): McpConfigFile[] {
  const h = home ?? homedir();
  const candidates: { type: McpClientType; path: string }[] = [
    { type: "claude-code", path: join(h, ".claude.json") },
    { type: "cursor",      path: join(h, ".cursor", "mcp.json") },
  ];
  return candidates.map(({ type, path }) => ({ type, path, exists: existsSync(path) }));
}

export function readScrybeEntry(file: McpConfigFile): ScrybeMcpEntry | null {
  if (!file.exists) return null;
  let raw: unknown;
  try {
    raw = JSON.parse(readFileSync(file.path, "utf8"));
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

export function proposeScrybeEntry(opts: { binResolution: "npx" | "local"; localPath?: string }): ScrybeMcpEntry {
  if (opts.binResolution === "npx") {
    return { command: "npx", args: ["-y", "scrybe-cli", "mcp"] };
  }
  if (!opts.localPath) throw new Error("localPath required for binResolution='local'");
  return { command: process.execPath, args: [opts.localPath, "mcp"] };
}

export function computeDiff(file: McpConfigFile, proposed: ScrybeMcpEntry): McpEntryDiff {
  const existing = readScrybeEntry(file);
  const existingStr = existing ? JSON.stringify(existing, null, 2) : null;
  const proposedStr = JSON.stringify(proposed, null, 2);

  let action: McpEntryDiff["action"];
  let diff: string;

  if (!existing) {
    action = "add";
    diff = `+ "scrybe": ${proposedStr}`;
  } else if (existingStr === proposedStr) {
    action = "skip";
    diff = `  "scrybe": ${proposedStr}  (no change)`;
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

  const { path } = diff.file;
  const dir = dirname(path);
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });

  // Load or create the config
  let raw: Record<string, unknown> = {};
  if (existsSync(path)) {
    try {
      raw = JSON.parse(readFileSync(path, "utf8")) as Record<string, unknown>;
    } catch {
      // Corrupt JSON — preserve with backup
      const backupPath = `${path}.bak-${Date.now()}`;
      writeFileSync(backupPath, readFileSync(path));
      raw = {};
    }
  }

  // Inject or replace scrybe entry
  if (!raw["mcpServers"] || typeof raw["mcpServers"] !== "object") {
    raw["mcpServers"] = {};
  }
  (raw["mcpServers"] as Record<string, unknown>)["scrybe"] = diff.proposed;

  // Atomic write: tmp → rename (avoids partial-write corruption)
  const tmp = `${path}.tmp-${randomBytes(4).toString("hex")}`;
  writeFileSync(tmp, JSON.stringify(raw, null, 2) + "\n", "utf8");
  try {
    renameSync(tmp, path);
  } catch {
    // Windows: rename fails if target exists (shouldn't, but guard)
    try { unlinkSync(path); } catch { /* ignore */ }
    renameSync(tmp, path);
  }
}
