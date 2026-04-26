/**
 * CLI surface regression scenarios:
 * - SQLite warning not leaking (M-D14 C1)
 * - `--auto` flag removed (M-D14 breaking change)
 * - project rm / project ls aliases (M-D14 C7)
 * - search bare missing -P hint (M-D14 C12)
 * - ps aligned columns (M-D14 C8)
 * - project list status icons (M-D14 C3)
 */
import { describe, it, expect, afterEach } from "vitest";
import { makeScenarioEnv, runScrybe, type ScenarioEnv } from "./helpers/spawn.js";
import { makeTempRepo, type TempRepo } from "./helpers/repo.js";

let env: ScenarioEnv | null = null;
let repo: TempRepo | null = null;

afterEach(() => {
  env?.cleanup(); env = null;
  repo?.cleanup(); repo = null;
});

describe("C1 — SQLite ExperimentalWarning suppressed", () => {
  it("no ExperimentalWarning in stderr on any command", () => {
    env = makeScenarioEnv();
    const r = runScrybe(["project", "list"], env);
    expect(r.stderr).not.toContain("ExperimentalWarning");
    expect(r.stderr).not.toContain("SQLite is an experimental");
  });
});

describe("C7 — project rm / ls aliases", () => {
  it("project ls works as alias for project list", () => {
    env = makeScenarioEnv();
    const r = runScrybe(["project", "ls"], env);
    expect(r.exit).toBe(0);
    expect(r.stderr).not.toContain("unknown command");
  });

  it("project rm <id> removes a project (positional + alias)", () => {
    env = makeScenarioEnv();
    runScrybe(["project", "add", "--id", "alias-proj"], env);
    const r = runScrybe(["project", "rm", "alias-proj"], env);
    expect(r.exit).toBe(0);
    expect(r.stdout + r.stderr).toMatch(/removed|alias-proj/i);

    // Confirm it's gone
    const list = runScrybe(["project", "list"], env);
    expect(list.stdout).not.toContain("alias-proj");
  });

  it("project delete <id> also removes a project", () => {
    env = makeScenarioEnv();
    runScrybe(["project", "add", "--id", "del-proj"], env);
    const r = runScrybe(["project", "delete", "del-proj"], env);
    expect(r.exit).toBe(0);
  });
});

describe("C12 — search bare without -P shows helpful hint", () => {
  it("scrybe search <query> without --project-id prints hint not 'undefined'", () => {
    env = makeScenarioEnv();
    const r = runScrybe(["search", "hello world"], env);
    // Should fail (no project), but with a helpful message
    expect(r.exit).not.toBe(0);
    expect(r.stderr).not.toContain("'undefined'");
    expect(r.stderr).toMatch(/Missing project|project.id|-P/i);
  });
});

describe("--auto flag removed (M-D14 breaking change)", () => {
  it("--auto flag is not recognized (removed)", () => {
    env = makeScenarioEnv();
    const r = runScrybe(["--auto"], env);
    // Commander should reject unknown option, OR the bare action runs (no --auto branch)
    // Either way, output should NOT reference the old --auto behavior
    expect(r.stdout + r.stderr).not.toContain("Auto-register and index current directory");
  });
});

describe("daemon up alias (M-D14 C2)", () => {
  it("daemon up is recognized (no unknown-command error)", () => {
    env = makeScenarioEnv();
    const r = runScrybe(["daemon", "up", "--verbose"], env);
    expect(r.stderr).not.toContain("unknown command");
    // May succeed (daemon starts) or report SCRYBE_NO_AUTO_DAEMON — both OK
  });
});

describe("C8 — ps aligned columns", () => {
  it("ps output contains column headers after registering a source", () => {
    env = makeScenarioEnv();
    repo = makeTempRepo({ "src/x.ts": "const x = 1;\n" });

    runScrybe(["project", "add", "--id", "ps-proj"], env);
    runScrybe(["source", "add", "-P", "ps-proj", "-S", "primary",
      "--type", "code", "--root", repo.path, "--languages", "ts"], env);
    runScrybe(["index", "-P", "ps-proj", "-S", "primary", "-f"], env);

    const r = runScrybe(["ps"], env);
    expect(r.exit).toBe(0);
    // Column headers from C8 formatter
    expect(r.stdout).toMatch(/PROJECT|SOURCE|CHUNKS|LAST INDEXED/i);
    expect(r.stdout).toContain("ps-proj");
  });
});

describe("C3 — project list status icons", () => {
  it("project list shows status icon (✓ or ○) per source", () => {
    env = makeScenarioEnv();
    repo = makeTempRepo({ "src/x.ts": "const x = 1;\n" });

    runScrybe(["project", "add", "--id", "icon-proj"], env);
    runScrybe(["source", "add", "-P", "icon-proj", "-S", "primary",
      "--type", "code", "--root", repo.path, "--languages", "ts"], env);
    runScrybe(["index", "-P", "icon-proj", "-S", "primary", "-f"], env);

    const r = runScrybe(["project", "list"], env);
    expect(r.exit).toBe(0);
    expect(r.stdout).toMatch(/[✓○✗]/);
  });
});
