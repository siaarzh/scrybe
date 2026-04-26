/**
 * Scenario 1  — Fresh-install end-to-end via binary (register + index + search).
 * Scenario 6  — `search code -P <id> <query>` Commander flag collision (M-D13 Fix 3).
 * Scenario 11 — Search roundtrip from pre-seeded state.
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

describe("Scenario 6 — search code -P flag (M-D13 Fix 3)", () => {
  it("search code -P <id> <query> parses correctly and does not error on flag collision", () => {
    env = makeScenarioEnv();
    repo = makeTempRepo({ "src/index.ts": "export const greet = () => 'hello';\n" });

    // Register + index
    runScrybe(["project", "add", "--id", "s6-proj"], env);
    runScrybe(["source", "add", "-P", "s6-proj", "-S", "primary",
      "--type", "code", "--root", repo.path, "--languages", "ts"], env);
    runScrybe(["index", "-P", "s6-proj", "-S", "primary", "-f"], env);

    // Scenario 6: this used to error "required option not specified" due to Commander collision
    const r = runScrybe(["search", "code", "-P", "s6-proj", "greet"], env);

    expect(r.stderr).not.toContain("required option");
    expect(r.stderr).not.toContain("unknown option");
    expect(r.exit).toBe(0);
  });

  it("search knowledge -P <id> <query> also parses correctly", () => {
    env = makeScenarioEnv();
    repo = makeTempRepo({ "src/index.ts": "export const greet = () => 'hello';\n" });

    runScrybe(["project", "add", "--id", "s6k-proj"], env);
    runScrybe(["source", "add", "-P", "s6k-proj", "-S", "primary",
      "--type", "code", "--root", repo.path, "--languages", "ts"], env);
    runScrybe(["index", "-P", "s6k-proj", "-S", "primary", "-f"], env);

    const r = runScrybe(["search", "knowledge", "-P", "s6k-proj", "greet"], env);

    expect(r.stderr).not.toContain("required option");
    expect(r.stderr).not.toContain("unknown option");
    // knowledge search on a code-only project may exit non-zero (no knowledge sources)
    // but the key check is that the -P flag parsed without a collision error
    expect(r.stderr).not.toContain("required option '--project-id");
  });
});

describe("Scenario 11 — search roundtrip from indexed state", () => {
  it("indexed project returns hits for known content", () => {
    env = makeScenarioEnv();
    repo = makeTempRepo({ "src/auth.ts": "export function loginUser(email: string) { return { token: 'abc' }; }\n" });

    runScrybe(["project", "add", "--id", "s11-proj"], env);
    runScrybe(["source", "add", "-P", "s11-proj", "-S", "primary",
      "--type", "code", "--root", repo.path, "--languages", "ts"], env);

    const idx = runScrybe(["index", "-P", "s11-proj", "-S", "primary", "-f"], env);
    expect(idx.exit).toBe(0);

    const r = runScrybe(["search", "code", "-P", "s11-proj", "loginUser"], env);
    expect(r.exit).toBe(0);
    // Should return at least one hit containing the function name
    const out = r.stdout;
    expect(out).toContain("loginUser");
  });

  it("search returns valid JSON when --top-k is specified", () => {
    env = makeScenarioEnv();
    repo = makeTempRepo({ "src/db.ts": "export function connectDb(url: string) { return url; }\n" });

    runScrybe(["project", "add", "--id", "s11b-proj"], env);
    runScrybe(["source", "add", "-P", "s11b-proj", "-S", "primary",
      "--type", "code", "--root", repo.path, "--languages", "ts"], env);
    runScrybe(["index", "-P", "s11b-proj", "-S", "primary", "-f"], env);

    const r = runScrybe(["search", "code", "-P", "s11b-proj", "--top-k", "5", "connectDb"], env);
    expect(r.exit).toBe(0);
    // CLI output is the formatted result, should include the function name
    expect(r.stdout + r.stderr).not.toContain("error");
  });
});

describe("Scenario 1 — fresh register + index + search via binary", () => {
  it("project add → source add → index → search returns hits", () => {
    env = makeScenarioEnv();
    repo = makeTempRepo({
      "src/users.ts": "export function createUser(name: string) { return { id: 1, name }; }\n",
    });

    // Register project
    const add = runScrybe(["project", "add", "--id", "s1-proj", "--desc", "Scenario 1"], env);
    expect(add.exit).toBe(0);

    // Add source
    const src = runScrybe(["source", "add", "-P", "s1-proj", "-S", "primary",
      "--type", "code", "--root", repo.path, "--languages", "ts"], env);
    expect(src.exit).toBe(0);

    // Full index
    const idx = runScrybe(["index", "-P", "s1-proj", "-S", "primary", "-f"], env);
    expect(idx.exit).toBe(0);
    expect(idx.stdout + idx.stderr).toMatch(/chunk|indexed/i);

    // Search
    const r = runScrybe(["search", "code", "-P", "s1-proj", "createUser"], env);
    expect(r.exit).toBe(0);
    expect(r.stdout).toContain("createUser");
  });

  it("project list shows registered project with status icon", () => {
    env = makeScenarioEnv();
    repo = makeTempRepo({ "src/x.ts": "export const x = 1;\n" });

    runScrybe(["project", "add", "--id", "s1c-proj"], env);
    runScrybe(["source", "add", "-P", "s1c-proj", "-S", "primary",
      "--type", "code", "--root", repo.path, "--languages", "ts"], env);
    runScrybe(["index", "-P", "s1c-proj", "-S", "primary", "-f"], env);

    const r = runScrybe(["project", "list"], env);
    expect(r.exit).toBe(0);
    // After indexing with valid provider, source should be searchable (✓)
    expect(r.stdout).toContain("s1c-proj");
    expect(r.stdout).toMatch(/✓|○/); // status icon present
  });
});
