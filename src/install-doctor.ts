/**
 * install-doctor.ts
 *
 * Detects half-extracted npx installs (SIGTERM'd during first MCP probe)
 * and provides structured recovery paths for MCP and CLI surfaces.
 *
 * Imports only node:* builtins at static top.
 * Lazy-imports @modelcontextprotocol/sdk only inside emitInstallErrorOverMcp.
 */

import { createRequire } from "node:module";
import { dirname, basename } from "node:path";
import { fileURLToPath } from "node:url";
import { existsSync, writeFileSync, unlinkSync } from "node:fs";
import { spawnSync, spawn } from "node:child_process";

// ── Landmark dependencies ────────────────────────────────────────────────────
// Heaviest direct deps + packages with native install scripts.
// Most likely to be left half-extracted when npm is SIGTERM'd.
const LANDMARK_DEPS = [
  "@xenova/transformers",
  "sharp",
  "@lancedb/lancedb",
  "apache-arrow",
  "@modelcontextprotocol/sdk",
  "@parcel/watcher",
  "tree-sitter",
] as const;

// ── Types ────────────────────────────────────────────────────────────────────

export interface BrokenInstall {
  missing: string[];
}

// ── detectBrokenInstall ──────────────────────────────────────────────────────

/**
 * Check whether all landmark dependencies are resolvable from the current
 * install location. Returns null if everything is ok, or a BrokenInstall
 * object listing the missing deps.
 */
export function detectBrokenInstall(): BrokenInstall | null {
  const req = createRequire(import.meta.url);
  const missing: string[] = [];
  for (const dep of LANDMARK_DEPS) {
    // Try resolving package.json first; some packages don't export it,
    // so fall back to resolving the main entry point.
    let resolved = false;
    try {
      req.resolve(`${dep}/package.json`);
      resolved = true;
    } catch {
      // package.json not exported — try resolving the package root
      try {
        req.resolve(dep);
        resolved = true;
      } catch {
        // package not resolvable at all
      }
    }
    if (!resolved) missing.push(dep);
  }
  return missing.length > 0 ? { missing } : null;
}

// ── formatBrokenInstallText ──────────────────────────────────────────────────

/**
 * Format recovery text for a broken install.
 * First line ≤100 chars = bare copy-pasteable command (fits Claude Code tool preview).
 * Explanation follows on subsequent lines.
 */
export function formatBrokenInstallText(b: BrokenInstall): string {
  // First line: action-first, ≤100 chars (this one is 56 chars)
  const firstLine = "Run: npx -y scrybe-cli@latest --version  (then reconnect)";
  const detail = [
    "",
    "scrybe's first install was interrupted by Claude Code's MCP probe timeout.",
    "The above seeds the npx cache uninterrupted (~10s) and resolves the issue.",
    "",
    `Missing packages: ${b.missing.join(", ")}`,
    "",
    "Alternatively, install globally and use the 'command: scrybe' MCP config:",
    "  npm install -g scrybe-cli",
    "  scrybe doctor --repair",
  ].join("\n");
  return firstLine + "\n" + detail;
}

// ── emitInstallErrorOverMcp ──────────────────────────────────────────────────

/**
 * Open a minimal MCP server on stdio, register a single error tool
 * (`scrybe_install_incomplete`), and serve until stdin closes.
 *
 * The tool description starts with the bare recovery command so Claude Code's
 * tool-list preview (~120 chars) shows the actionable line first.
 *
 * @modelcontextprotocol/sdk is lazy-imported here because it is dep-light
 * and almost always extracted intact even when sharp/xenova are half-extracted.
 */
export async function emitInstallErrorOverMcp(b: BrokenInstall): Promise<void> {
  // Lazy import — SDK only needed on MCP path
  const { Server } = await import("@modelcontextprotocol/sdk/server/index.js");
  const { StdioServerTransport } = await import("@modelcontextprotocol/sdk/server/stdio.js");
  const {
    ListToolsRequestSchema,
    CallToolRequestSchema,
  } = await import("@modelcontextprotocol/sdk/types.js");

  const recoveryText = formatBrokenInstallText(b);

  const server = new Server(
    { name: "scrybe (install incomplete)", version: "0.0.0" },
    { capabilities: { tools: {} } },
  );

  server.setRequestHandler(ListToolsRequestSchema, () => ({
    tools: [
      {
        name: "scrybe_install_incomplete",
        description: recoveryText,
        inputSchema: { type: "object" as const, properties: {}, required: [] },
      },
    ],
  }));

  server.setRequestHandler(CallToolRequestSchema, () => ({
    content: [{ type: "text" as const, text: recoveryText }],
    isError: true,
  }));

  const transport = new StdioServerTransport();
  await server.connect(transport);

  // Keep alive until stdin closes (Claude Code MCP probe will disconnect)
  await new Promise<void>((resolve) => {
    process.stdin.on("close", resolve);
    process.stdin.on("end", resolve);
  });
}

// ── findNpxWorkspaceRoot ─────────────────────────────────────────────────────

/**
 * Walk up from the current file's directory looking for a `_npx` ancestor.
 * Returns the direct child of `_npx/` (= the npx workspace root) or null
 * if the file is not inside an npx cache (global install).
 *
 * Check is on the *parent* dir's basename, not on workspaceRoot itself —
 * the workspace root is the child of `_npx/`, not `_npx/` itself.
 *
 * Supports both npm 10 hoisted layout:
 *   ~/.npm/_npx/<hash>/node_modules/scrybe-cli/dist/index.js
 * and npm 9 nested layout (rare):
 *   ~/.npm/_npx/<hash>/node_modules/<wrapper>/node_modules/scrybe-cli/dist/index.js
 * Both return `~/.npm/_npx/<hash>` (outermost `_npx`-child wins).
 */
export function findNpxWorkspaceRoot(): string | null {
  let current = dirname(fileURLToPath(import.meta.url));

  while (true) {
    const parent = dirname(current);
    // Terminated at filesystem root
    if (parent === current) return null;
    if (basename(parent) === "_npx") return current;
    current = parent;
  }
}

// ── attemptSelfRepair ────────────────────────────────────────────────────────

/**
 * Attempt to self-repair a broken npx install by running `npm install`
 * in the npx workspace root, then re-executing the current process.
 *
 * Only runs inside an npx cache (`_npx` ancestor found).
 * Guards against recursion via sentinel file + env var.
 *
 * Returns true if repair was initiated and re-exec spawned (caller should
 * exit immediately after via child's close handler).
 * Returns false if repair not applicable or failed.
 */
export function attemptSelfRepair(b: BrokenInstall): boolean {
  // Only repair inside npx cache
  const workspaceRoot = findNpxWorkspaceRoot();
  if (!workspaceRoot) {
    // Global install — can't self-repair
    return false;
  }

  // Recursion guard
  const sentinelFile = `${workspaceRoot}/.scrybe-repair-attempted`;
  if (process.env["SCRYBE_SELF_REPAIR_ATTEMPTED"] === "1" || existsSync(sentinelFile)) {
    process.stderr.write(
      "[scrybe] Self-repair already attempted and failed.\n" +
      formatBrokenInstallText(b) + "\n",
    );
    return false;
  }

  // Mark repair attempted (before running npm install, in case it crashes)
  try {
    writeFileSync(sentinelFile, new Date().toISOString());
  } catch {
    // Non-fatal — env var guard is the primary recursion stopper
  }

  process.stderr.write("[scrybe] Incomplete install detected. Running npm install to repair...\n");

  const result = spawnSync(
    "npm",
    ["install", "--no-audit", "--no-fund", "--no-progress"],
    {
      cwd: workspaceRoot,
      timeout: 120_000,
      stdio: "inherit",
      shell: process.platform === "win32",
    },
  );

  if (result.status !== 0) {
    process.stderr.write(
      "[scrybe] npm install failed. Manual recovery:\n" +
      formatBrokenInstallText(b) + "\n",
    );
    return false;
  }

  // Remove sentinel — repair succeeded, clean state for future runs
  try {
    unlinkSync(sentinelFile);
  } catch {
    // Non-fatal
  }

  process.stderr.write("[scrybe] Repair complete. Restarting...\n");

  // Re-exec with the repaired install
  const child = spawn(process.execPath, process.argv.slice(1), {
    stdio: "inherit",
    env: { ...process.env, SCRYBE_SELF_REPAIR_ATTEMPTED: "1" },
  });

  child.on("close", (code) => {
    process.exit(code ?? 0);
  });

  child.on("error", (err) => {
    process.stderr.write(`[scrybe] Re-exec failed: ${err.message}\n`);
    process.exit(1);
  });

  return true;
}
