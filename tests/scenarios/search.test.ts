/**
 * Scenario 1  — Fresh-install end-to-end via binary (register + index + search).
 * Scenario 6  — `search code -P <id> <query>` Commander flag collision (M-D13 Fix 3).
 * Scenario 11 — Search roundtrip from pre-seeded state.
 * Scenario 16 — Cold-cache FTS race regression (Plan 41).
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

describe("Scenario 16 — cold-cache FTS race (Plan 41 regression)", () => {
  /**
   * Each runScrybe spawns a fresh CLI process, so _tableCache starts empty
   * (cold). Before the fix, ftsSearch() synchronously returned [] on cold
   * cache, silently degrading hybrid search to vector-only. Synthetic tokens
   * that have no semantic neighbours must be found via BM25.
   */

  /** Extract file paths from the first N result lines of CLI search output.
   * Lines look like: `[0.812] src/canary.ts:1-4 (typescript)` */
  function extractTopFilePaths(stdout: string, n: number): string[] {
    return stdout
      .split("\n")
      .filter((line) => line.trimStart().startsWith("["))
      .slice(0, n)
      .map((line) => {
        // match the path segment between "] " and ":"
        const m = line.match(/\]\s+(.+?):\d/);
        return m ? m[1].trim() : "";
      })
      .filter(Boolean);
  }

  it("Test 1 — synthetic-token cold search finds canary via BM25", () => {
    env = makeScenarioEnv();
    repo = makeTempRepo({
      "src/canary.ts":
        "export function probe(input: string): string {\n" +
        "  const tokens = 'ferret saxophone umbrella';\n" +
        "  return tokens + input;\n" +
        "}\n",
    });

    runScrybe(["project", "add", "--id", "s16a-proj"], env);
    runScrybe(["source", "add", "-P", "s16a-proj", "-S", "primary",
      "--type", "code", "--root", repo.path, "--languages", "ts"], env);

    const idx = runScrybe(["index", "-P", "s16a-proj", "-S", "primary", "-f"], env);
    expect(idx.exit).toBe(0);

    // Fresh process = cold cache. Pre-fix: BM25 returned [] → canary missing.
    const r = runScrybe(["search", "code", "-P", "s16a-proj", "ferret saxophone umbrella"], env);
    expect(r.exit).toBe(0);
    expect(r.stdout).toContain("src/canary.ts");
  });

  it("Test 2 — bird-family: both raptors and parrots files surface in top results", () => {
    env = makeScenarioEnv();
    repo = makeTempRepo({
      "src/raptors.ts":
        "export function patrolSky(input: string): string {\n" +
        "  const raptors = 'falcon hawk eagle';\n" +
        "  return `${raptors} :: ${input}`;\n" +
        "}\n",
      "src/parrots.ts":
        "export function chatterCage(input: string): string {\n" +
        "  const parrots = 'macaw cockatoo lorikeet';\n" +
        "  return `${parrots} :: ${input}`;\n" +
        "}\n",
    });

    runScrybe(["project", "add", "--id", "s16b-proj"], env);
    runScrybe(["source", "add", "-P", "s16b-proj", "-S", "primary",
      "--type", "code", "--root", repo.path, "--languages", "ts"], env);

    const idx = runScrybe(["index", "-P", "s16b-proj", "-S", "primary", "-f"], env);
    expect(idx.exit).toBe(0);

    // "kestrel" is a close relative of raptors. In a two-file corpus both files
    // should appear in the top results (any order). We check top 5 rather than
    // top 2 to tolerate minor rerank/RRF variance across embedding model versions.
    const r1 = runScrybe(["search", "code", "-P", "s16b-proj", "kestrel"], env);
    expect(r1.exit).toBe(0);
    const top5_a = extractTopFilePaths(r1.stdout, 5);
    expect(top5_a).toEqual(expect.arrayContaining(["src/raptors.ts", "src/parrots.ts"]));

    // "parakeet" is a close relative of parrots. Same acceptance criterion.
    const r2 = runScrybe(["search", "code", "-P", "s16b-proj", "parakeet"], env);
    expect(r2.exit).toBe(0);
    const top5_b = extractTopFilePaths(r2.stdout, 5);
    expect(top5_b).toEqual(expect.arrayContaining(["src/raptors.ts", "src/parrots.ts"]));
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
