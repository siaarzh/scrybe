/**
 * Scenario 19 — Two-writer race (Fix F).
 * Validates Fix B's retry-on-conflict by spawning two concurrent CLI processes
 * with SCRYBE_NO_AUTO_DAEMON=1 against the same LanceDB table.
 *
 * The test contract: race must not fail BOTH writers.
 * At least one process must exit 0. If a commit conflict fires, Fix B's
 * retry path emits a log line that we assert appeared in at least one run.
 */
import { describe, it, expect, afterEach } from "vitest";
import { makeScenarioEnv, runScrybe, type ScenarioEnv } from "./helpers/spawn.js";
import { spawnScrybe } from "./helpers/async-spawn.js";
import { makeTempRepo, type TempRepo } from "./helpers/repo.js";

let env: ScenarioEnv | null = null;
let repo: TempRepo | null = null;

afterEach(() => {
  env?.cleanup(); env = null;
  repo?.cleanup(); repo = null;
});

describe("Scenario 19 — two-writer race (Fix F)", () => {
  it("at least one writer succeeds when two full reindexes race on the same table", async () => {
    env = makeScenarioEnv();
    repo = makeTempRepo({
      "src/alpha.ts": "export const alpha = 1;\n",
      "src/beta.ts":  "export const beta  = 2;\n",
    });

    // Register project and index once to create the Lance table
    runScrybe(["project", "add", "--id", "s19-proj"], env);
    runScrybe(["source", "add", "-P", "s19-proj", "-S", "primary",
      "--type", "code", "--root", repo.path, "--languages", "ts"], env);
    const init = runScrybe(["index", "-P", "s19-proj", "-S", "primary", "-f"],
      env, { SCRYBE_NO_AUTO_DAEMON: "1" });
    expect(init.exit).toBe(0);

    // Both processes use SCRYBE_NO_AUTO_DAEMON=1 (opt-out path — no queue serialization).
    // SCRYBE_TEST_WRITE_DELAY_MS widens the conflict window so the race fires reliably.
    const extra = { SCRYBE_NO_AUTO_DAEMON: "1", SCRYBE_TEST_WRITE_DELAY_MS: "50" };
    const args  = ["index", "-P", "s19-proj", "-S", "primary", "-f"];

    const [r1, r2] = await Promise.all([
      spawnScrybe(args, env, extra),
      spawnScrybe(args, env, extra),
    ]);

    // Main contract: race must not fail both writers
    const exits = [r1.exit, r2.exit];
    expect(exits.some((c) => c === 0)).toBe(true);

    // If a commit conflict fired, Fix B's retry message should appear in stderr
    const allStderr = r1.stderr + r2.stderr;
    if (allStderr.includes("commit conflict")) {
      expect(allStderr).toContain("evicting cached table handle and retrying");
    }
  }, 120_000);
});
