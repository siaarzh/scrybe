/**
 * Tests that `scrybe mcp --legacy-in-process` emits a deprecation warning to stderr.
 *
 * The warning must appear at startup, before any tool call is processed.
 * Uses the built dist/index.js so the actual dispatch path is exercised.
 * The MCP process is spawned and killed immediately after capturing stderr output.
 */
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { spawn } from "child_process";
import { join } from "path";
import { mkdtempSync, rmSync } from "fs";
import { tmpdir } from "os";

const CLI = join(import.meta.dirname, "../dist/index.js");
const NODE = process.execPath;

let dataDir = "";
beforeAll(() => { dataDir = mkdtempSync(join(tmpdir(), "scrybe-legacy-dep-")); });
afterAll(() => { try { rmSync(dataDir, { recursive: true, force: true }); } catch { /* ignore */ } });

describe("legacy in-process MCP mode deprecation warning", () => {
  it("emits deprecation warning to stderr on startup", async () => {
    const collected: string[] = [];

    await new Promise<void>((resolve, reject) => {
      const child = spawn(NODE, [CLI, "mcp", "--legacy-in-process"], {
        env: { ...process.env, SCRYBE_DATA_DIR: dataDir },
        stdio: ["pipe", "pipe", "pipe"],
      });

      child.stderr.on("data", (chunk: Buffer) => {
        collected.push(chunk.toString());
      });

      // Give the process up to 3 seconds to emit the warning, then kill it.
      // The MCP server will hang waiting for stdin — we don't need it to complete.
      const timer = setTimeout(() => {
        child.kill("SIGTERM");
      }, 3000);

      child.on("close", () => {
        clearTimeout(timer);
        resolve();
      });

      child.on("error", (err) => {
        clearTimeout(timer);
        reject(err);
      });
    });

    const stderr = collected.join("");
    expect(stderr).toContain("in-process MCP mode is deprecated");
    expect(stderr).toContain("v0.34.0");
    expect(stderr).toContain("scrybe daemon install");
  });
});
