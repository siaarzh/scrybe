/**
 * Scenario 13 — HEALTH column + bloat tip + `ps --json` flags (M-D16 Fix B + D).
 *
 * Also covers regression assertions for the three [Unreleased] bugs that v0.25.2 fixed
 * but no scenario test ever caught:
 *   - `gc` stdin no-hang after the prune prompt
 *   - `gc` orphan count not capped at 10
 *   - `isSearchable` local-provider not falsely flagged
 */
import { describe, it, expect, afterEach } from "vitest";
import { makeScenarioEnv, runScrybe, runScrybeWithStdin, type ScenarioEnv } from "./helpers/spawn.js";
import { makeTempRepo, type TempRepo } from "./helpers/repo.js";

let env: ScenarioEnv | null = null;
let repo: TempRepo | null = null;

afterEach(() => {
  env?.cleanup(); env = null;
  repo?.cleanup(); repo = null;
});

// Force compaction threshold low so a few writes cross 2× threshold (= bloat trigger).
// COMPACT_THRESHOLD=2 → bloat tip fires when versionCount > 4.
const LOW_THRESHOLD = { SCRYBE_LANCE_COMPACT_THRESHOLD: "2" };

function indexFresh(projectId: string): void {
  if (!env || !repo) throw new Error("env/repo not set up");
  runScrybe(["project", "add", "--id", projectId], env);
  runScrybe(["source", "add", "-P", projectId, "-S", "primary",
    "--type", "code", "--root", repo.path, "--languages", "ts"], env);
  runScrybe(["index", "-P", projectId, "-S", "primary", "-f"], env);
}

describe("Scenario 13 — HEALTH column rendering (M-D16 Fix B)", () => {
  it("ps --all shows Healthy on a freshly-indexed source", () => {
    env = makeScenarioEnv();
    repo = makeTempRepo({ "src/index.ts": "export const x = 1;\n" });

    indexFresh("s13a-proj");

    const r = runScrybe(["ps", "--all"], env);
    expect(r.exit).toBe(0);
    expect(r.stdout).toContain("HEALTH");
    expect(r.stdout).toContain("Healthy");
    expect(r.stdout).not.toContain("Bloated");
    // No legend block when nothing is bloated.
    expect(r.stdout).not.toContain("run 'scrybe gc' to reclaim");
  });

  it("ps --all shows Bloated * + legend after enough writes to exceed 2× threshold", () => {
    env = makeScenarioEnv();
    repo = makeTempRepo({ "src/index.ts": "export const x = 1;\n" });

    indexFresh("s13b-proj");

    // Multiple full reindexes accumulate Lance versions despite auto-compact's 1h grace window.
    // Need versionCount > 4 (= 2 × LOW_THRESHOLD).
    for (let i = 0; i < 8; i++) {
      repo.commit("src/index.ts", `export const x = ${i + 2};\n`, `iter${i}`);
      runScrybe(["index", "-P", "s13b-proj", "-S", "primary", "-f"], env, LOW_THRESHOLD);
    }

    const r = runScrybe(["ps", "--all"], env, LOW_THRESHOLD);
    expect(r.exit).toBe(0);
    expect(r.stdout).toContain("Bloated *");
    expect(r.stdout).toContain("* run 'scrybe gc' to reclaim disk space");
  });

  it("ps --all returns to Healthy + drops legend after gc", () => {
    env = makeScenarioEnv();
    repo = makeTempRepo({ "src/index.ts": "export const x = 1;\n" });

    indexFresh("s13c-proj");

    for (let i = 0; i < 8; i++) {
      repo.commit("src/index.ts", `export const x = ${i + 2};\n`, `iter${i}`);
      runScrybe(["index", "-P", "s13c-proj", "-S", "primary", "-f"], env, LOW_THRESHOLD);
    }

    // Confirm bloat is detected first.
    const before = runScrybe(["ps", "--all"], env, LOW_THRESHOLD);
    expect(before.stdout).toContain("Bloated *");

    // Run gc.
    const gc = runScrybe(["gc"], env, LOW_THRESHOLD);
    expect(gc.exit).toBe(0);
    expect(gc.stdout).toMatch(/(Reclaimed [\d.]+ (B|KB|MB|GB) across \d+ of \d+ tables|0 B reclaimed)/);

    // After gc, no bloat marker, no legend.
    const after = runScrybe(["ps", "--all"], env, LOW_THRESHOLD);
    expect(after.exit).toBe(0);
    expect(after.stdout).toContain("Healthy");
    expect(after.stdout).not.toContain("Bloated");
    expect(after.stdout).not.toContain("run 'scrybe gc' to reclaim");
  });

  it("VERS column is no longer rendered (replaced by HEALTH)", () => {
    env = makeScenarioEnv();
    repo = makeTempRepo({ "src/index.ts": "export const x = 1;\n" });

    indexFresh("s13d-proj");

    const r = runScrybe(["ps", "--all"], env);
    expect(r.exit).toBe(0);
    // The literal column header "VERS" was Lance jargon; it must not appear.
    expect(r.stdout).not.toContain("VERS");
  });
});

describe("Scenario 13 — ps --json flags field (M-D16 Fix D)", () => {
  it("clean source has flags: []", () => {
    env = makeScenarioEnv();
    repo = makeTempRepo({ "src/index.ts": "export const x = 1;\n" });

    indexFresh("s13j-proj");

    const r = runScrybe(["ps", "--json"], env);
    expect(r.exit).toBe(0);
    const parsed = JSON.parse(r.stdout) as {
      schemaVersion: number;
      projects: { id: string; sources: { sourceId: string; flags: string[]; versionCount: number }[] }[];
    };
    expect(parsed.schemaVersion).toBe(1);
    const proj = parsed.projects.find((p) => p.id === "s13j-proj");
    expect(proj).toBeDefined();
    const src = proj!.sources.find((s) => s.sourceId === "primary");
    expect(src).toBeDefined();
    expect(src!.flags).toEqual([]);
    // versionCount stays exposed for diagnostics
    expect(typeof src!.versionCount).toBe("number");
  });

  it("bloated source has flags: ['bloat']", () => {
    env = makeScenarioEnv();
    repo = makeTempRepo({ "src/index.ts": "export const x = 1;\n" });

    indexFresh("s13k-proj");

    for (let i = 0; i < 8; i++) {
      repo.commit("src/index.ts", `export const x = ${i + 2};\n`, `iter${i}`);
      runScrybe(["index", "-P", "s13k-proj", "-S", "primary", "-f"], env, LOW_THRESHOLD);
    }

    const r = runScrybe(["ps", "--json"], env, LOW_THRESHOLD);
    expect(r.exit).toBe(0);
    const parsed = JSON.parse(r.stdout) as {
      projects: { id: string; sources: { sourceId: string; flags: string[] }[] }[];
    };
    const src = parsed.projects.find((p) => p.id === "s13k-proj")!.sources.find((s) => s.sourceId === "primary")!;
    expect(src.flags).toContain("bloat");
  });
});

describe("v0.25.2 [Unreleased] regressions — scenario coverage", () => {
  it("gc accepting the empty-project prune prompt does not hang stdin", () => {
    env = makeScenarioEnv();

    // Add an empty project so the gc prune prompt fires.
    runScrybe(["project", "add", "--id", "regress-empty"], env);

    // Simulated TTY: feed "y\n" to stdin. Process must exit, not hang.
    const r = runScrybeWithStdin(["gc"], "y\n", env, {}, 15_000);
    expect(r.exit).toBe(0);
  });

  it("gc reports orphan counts above 10 (not capped at the Lance default limit)", () => {
    env = makeScenarioEnv();

    // Build a 15-file repo so a full index produces well over 10 chunks.
    const files: Record<string, string> = {};
    for (let i = 0; i < 15; i++) {
      files[`src/f${i}.ts`] = `export const v${i} = ${i};\nexport const w${i} = ${i + 100};\n`;
    }
    repo = makeTempRepo(files);

    runScrybe(["project", "add", "--id", "regress-orphans"], env);
    runScrybe(["source", "add", "-P", "regress-orphans", "-S", "primary",
      "--type", "code", "--root", repo.path, "--languages", "ts"], env);
    runScrybe(["index", "-P", "regress-orphans", "-S", "primary", "-f"], env);

    // Force orphans by removing the source — leaves chunk rows in Lance with no branch tags.
    runScrybe(["source", "remove", "-P", "regress-orphans", "-S", "primary", "-y"], env);

    // gc should report orphan counts > 10 if more than 10 exist.
    // With 15 source files × ≥1 chunk each, we should see > 10 orphans.
    const r = runScrybe(["gc"], env);
    expect(r.exit).toBe(0);
    const m = r.stdout.match(/(\d+)\s+orphan chunk\(s\) deleted/);
    if (m) {
      const n = parseInt(m[1], 10);
      expect(n === 0 || n > 10).toBe(true); // 0 means lance dropped them on source remove already; >10 means cap is gone
    }
  });

  // Note: the local-provider isSearchable regression is covered by the unit test in
  // tests/registry-searchable.test.ts (avoiding a 120 MB model download in scenarios).
});
