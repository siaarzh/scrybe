/**
 * Fix 3 (Plan 31) — daemon version-skew warning.
 *
 * When the running daemon's version (from daemon.pid) differs from the CLI
 * version, the CLI must print a one-time warning to stderr.
 * Warning must be suppressed when SCRYBE_JSON_OUTPUT=1.
 *
 * Test strategy: write a fake daemon.pid with a mismatched version and no
 * reachable port (port=0 so no HTTP call succeeds), then run a CLI command
 * and assert the warning appears in stderr.
 */
import { describe, it, expect, afterEach } from "vitest";
import { mkdirSync, writeFileSync } from "fs";
import { join } from "path";
import { createRequire } from "module";
import { makeScenarioEnv, runScrybe, type ScenarioEnv } from "./helpers/spawn.js";

const req = createRequire(import.meta.url);
const pkg = req("../../package.json") as { version: string };
const CLI_VERSION = pkg.version;

/** A version that is definitely different from the current CLI version. */
const STALE_VERSION = CLI_VERSION === "0.28.2" ? "0.28.1" : "0.28.2";

let env: ScenarioEnv | null = null;

afterEach(() => {
  env?.cleanup();
  env = null;
});

function writeStalePidfile(dataDir: string, daemonVersion: string): void {
  mkdirSync(dataDir, { recursive: true });
  writeFileSync(
    join(dataDir, "daemon.pid"),
    JSON.stringify({
      pid: process.pid,    // current process — alive, so not stale
      port: 0,             // port 0 → no HTTP reachable; health check will fail
      startedAt: new Date().toISOString(),
      version: daemonVersion,
      dataDir,
      execPath: process.execPath,
    }),
    "utf8"
  );
}

describe("Fix 3 — version-skew warning", () => {
  it("prints a warning when daemon.pid version differs from CLI version", () => {
    env = makeScenarioEnv();
    // Seed schema.json so checkAndMigrate doesn't do destructive reset
    writeFileSync(
      join(env.dataDir, "schema.json"),
      JSON.stringify({ version: 4, migrations_applied: ["compact-tables-v0.23.2", "rename-env-vars-v0.29.0", "add-rerank-key-v0.29.1"] }),
      "utf8"
    );
    writeStalePidfile(env.dataDir, STALE_VERSION);

    // Run a simple command that goes through ensureRunning / fromPidfile
    const result = runScrybe(
      ["project", "list"],
      env,
      // Override SCRYBE_NO_AUTO_DAEMON=0 so the daemon path is exercised
      { SCRYBE_NO_AUTO_DAEMON: "0" }
    );

    // The command itself should succeed (warning doesn't fail anything)
    expect(result.exit).toBe(0);

    // Warning must appear in stderr
    expect(result.stderr).toContain(`daemon is running v${STALE_VERSION}`);
    expect(result.stderr).toContain(`CLI is v${CLI_VERSION}`);
    expect(result.stderr).toContain("scrybe daemon stop");
  });

  it("no warning when daemon.pid version matches CLI version", () => {
    env = makeScenarioEnv();
    writeFileSync(
      join(env.dataDir, "schema.json"),
      JSON.stringify({ version: 4, migrations_applied: ["compact-tables-v0.23.2", "rename-env-vars-v0.29.0", "add-rerank-key-v0.29.1"] }),
      "utf8"
    );
    writeStalePidfile(env.dataDir, CLI_VERSION); // same version

    const result = runScrybe(
      ["project", "list"],
      env,
      { SCRYBE_NO_AUTO_DAEMON: "0" }
    );

    expect(result.exit).toBe(0);
    expect(result.stderr).not.toContain("daemon is running");
  });

  it("no warning when no daemon.pid exists", () => {
    env = makeScenarioEnv();
    writeFileSync(
      join(env.dataDir, "schema.json"),
      JSON.stringify({ version: 4, migrations_applied: ["compact-tables-v0.23.2", "rename-env-vars-v0.29.0", "add-rerank-key-v0.29.1"] }),
      "utf8"
    );
    // No pidfile written

    const result = runScrybe(
      ["project", "list"],
      env,
      { SCRYBE_NO_AUTO_DAEMON: "0" }
    );

    expect(result.exit).toBe(0);
    expect(result.stderr).not.toContain("daemon is running");
  });

  it("warning is suppressed when SCRYBE_JSON_OUTPUT=1", () => {
    env = makeScenarioEnv();
    writeFileSync(
      join(env.dataDir, "schema.json"),
      JSON.stringify({ version: 4, migrations_applied: ["compact-tables-v0.23.2", "rename-env-vars-v0.29.0", "add-rerank-key-v0.29.1"] }),
      "utf8"
    );
    writeStalePidfile(env.dataDir, STALE_VERSION);

    const result = runScrybe(
      ["project", "list"],
      env,
      { SCRYBE_NO_AUTO_DAEMON: "0", SCRYBE_JSON_OUTPUT: "1" }
    );

    expect(result.exit).toBe(0);
    expect(result.stderr).not.toContain("daemon is running");
  });
});
