/** A pinned branch indexes origin/<branch> whoever starts the job; unpinned checkouts read the working tree. */
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { execFileSync } from "child_process";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync, readFileSync, existsSync } from "fs";
import { join } from "path";
import { tmpdir } from "os";
import { createTempProject, type TempProject } from "./helpers/project.js";

function git(cwd: string, ...args: string[]): string {
  return execFileSync(
    "git",
    ["-c", "core.hooksPath=/dev/null", "-c", "user.email=t@example.com", "-c", "user.name=t", ...args],
    { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }
  ).trim();
}

function commitFile(repo: string, rel: string, body: string): void {
  writeFileSync(join(repo, rel), body, "utf8");
  git(repo, "add", rel);
  git(repo, "commit", "-m", `add ${rel}`);
}

interface Fixture {
  root: string;
  clone: string;
  other: string;
  branch: string;
}

/** origin has one commit the clone lacks locally (until fetched); the clone has one local-only commit and one dirty file. */
async function makeFixture(): Promise<Fixture> {
  const { resolveBranchForPath } = await import("../src/branch-state.js");
  const root = mkdtempSync(join(tmpdir(), "scrybe-pinned-remote-"));
  const seed = join(root, "seed");
  mkdirSync(seed);
  git(seed, "init");
  commitFile(seed, "a.ts", "export const a = 1;\n");
  const origin = join(root, "origin.git");
  git(root, "clone", "--bare", seed, origin);
  const clone = join(root, "clone");
  const other = join(root, "other");
  git(root, "clone", origin, clone);
  git(root, "clone", origin, other);
  const branch = resolveBranchForPath(clone);

  commitFile(other, "remote.ts", "export const remoteOnly = 1;\n");
  git(other, "push", "origin", `HEAD:${branch}`);
  git(clone, "fetch", "origin");

  commitFile(clone, "local.ts", "export const localOnly = 1;\n");
  writeFileSync(join(clone, "dirty.ts"), "export const dirty = 1;\n", "utf8");
  return { root, clone, other, branch };
}

async function indexedFiles(p: TempProject, branch: string): Promise<string[]> {
  const { getDB } = await import("../src/branch-state.js");
  const rows = getDB()
    .prepare("SELECT DISTINCT file_path FROM branch_tags WHERE project_id=? AND source_id=? AND branch=?")
    .all(p.projectId, p.sourceId, branch) as { file_path: string }[];
  return rows.map((r) => r.file_path).sort();
}

function logEvents(path: string): Record<string, any>[] {
  if (!existsSync(path)) return [];
  return readFileSync(path, "utf8")
    .split("\n")
    .filter(Boolean)
    .map((l) => JSON.parse(l));
}

let fx: Fixture | undefined;
let project: TempProject | undefined;
let logPath = "";

async function setup(pinned: boolean): Promise<{ fx: Fixture; p: TempProject }> {
  fx = await makeFixture();
  logPath = join(fx.root, "daemon-log.jsonl");
  process.env["SCRYBE_DAEMON_LOG_PATH"] = logPath;
  project = await createTempProject({ rootPath: fx.clone });
  if (pinned) {
    const { updateSource } = await import("../src/registry.js");
    updateSource(project.projectId, project.sourceId, { pinned_branches: [fx.branch] });
  }
  return { fx, p: project };
}

afterEach(async () => {
  await project?.cleanup();
  delete process.env["SCRYBE_DAEMON_LOG_PATH"];
  if (fx) rmSync(fx.root, { recursive: true, force: true });
  fx = undefined;
  project = undefined;
});

describe("pinned branch indexes the remote copy", () => {
  it("(a) a job with no contentRef reads origin, not the local commit or the dirty file", async () => {
    const { fx, p } = await setup(true);
    const { indexSource } = await import("../src/indexer.js");
    await indexSource(p.projectId, p.sourceId, "full", { branch: fx.branch });
    expect(await indexedFiles(p, fx.branch)).toEqual(["a.ts", "remote.ts"]);
  });

  it("(b) a job with contentRef origin/<branch> yields the same tags", async () => {
    const { fx, p } = await setup(true);
    const { indexSource } = await import("../src/indexer.js");
    await indexSource(p.projectId, p.sourceId, "full", { branch: fx.branch });
    const first = await indexedFiles(p, fx.branch);
    await indexSource(p.projectId, p.sourceId, "full", { branch: fx.branch, contentRef: `origin/${fx.branch}` });
    expect(await indexedFiles(p, fx.branch)).toEqual(first);
    await indexSource(p.projectId, p.sourceId, "incremental", { branch: fx.branch });
    expect(await indexedFiles(p, fx.branch)).toEqual(first);
  });

  it("(c) a second incremental job at the same SHA short-circuits before any scan", async () => {
    const { fx, p } = await setup(true);
    const { indexSource } = await import("../src/indexer.js");
    await indexSource(p.projectId, p.sourceId, "incremental", { branch: fx.branch });
    const scansBefore = logEvents(logPath).filter((e) => e["event"] === "indexer.scan.completed").length;
    expect(scansBefore).toBe(1);

    const result = await indexSource(p.projectId, p.sourceId, "incremental", { branch: fx.branch });
    expect(result).toMatchObject({ status: "ok", files_scanned: 0, files_reindexed: 0, chunks_prepared: 0, files_removed: 0 });

    const events = logEvents(logPath);
    expect(events.filter((e) => e["event"] === "indexer.scan.completed")).toHaveLength(scansBefore);
    const summaries = events.filter((e) => e["event"] === "indexer.job.summary");
    expect(summaries.at(-1)?.["unchanged_sha"]).toBeTruthy();
    expect(await indexedFiles(p, fx.branch)).toEqual(["a.ts", "remote.ts"]);
  });

  it("(d) after origin advances and is fetched, the new content is indexed", async () => {
    const { fx, p } = await setup(true);
    const { indexSource } = await import("../src/indexer.js");
    const { getLastIndexedSha } = await import("../src/branch-state.js");
    await indexSource(p.projectId, p.sourceId, "incremental", { branch: fx.branch });

    commitFile(fx.other, "remote2.ts", "export const remoteTwo = 2;\n");
    git(fx.other, "push", "origin", `HEAD:${fx.branch}`);
    git(fx.clone, "fetch", "origin");

    await indexSource(p.projectId, p.sourceId, "incremental", { branch: fx.branch });
    expect(await indexedFiles(p, fx.branch)).toEqual(["a.ts", "remote.ts", "remote2.ts"]);
    expect(getLastIndexedSha(p.projectId, p.sourceId, fx.branch)).toBe(git(fx.clone, "rev-parse", `origin/${fx.branch}`));
  });

  it("(e) an unpinned checked-out branch still reads the working tree, dirty file included", async () => {
    const { fx, p } = await setup(false);
    const { indexSource } = await import("../src/indexer.js");
    await indexSource(p.projectId, p.sourceId, "full", { branch: fx.branch });
    expect(await indexedFiles(p, fx.branch)).toEqual(["a.ts", "dirty.ts", "local.ts"]);
  });

  it("(f) a pinned branch with no origin ref falls back to the working tree without throwing", async () => {
    const { fx, p } = await setup(true);
    git(fx.clone, "update-ref", "-d", `refs/remotes/origin/${fx.branch}`);
    const { indexSource } = await import("../src/indexer.js");
    await expect(indexSource(p.projectId, p.sourceId, "full", { branch: fx.branch })).resolves.toMatchObject({ status: "ok" });
    expect(await indexedFiles(p, fx.branch)).toEqual(["a.ts", "dirty.ts", "local.ts"]);
    expect(logEvents(logPath).some((e) => e["event"] === "indexer.pinned.remote_ref_missing")).toBe(true);
  });

  it("(g) warns with the dirty-file and local-commit counts, once per window", async () => {
    const { fx, p } = await setup(true);
    const { indexSource } = await import("../src/indexer.js");
    await indexSource(p.projectId, p.sourceId, "incremental", { branch: fx.branch });
    await indexSource(p.projectId, p.sourceId, "incremental", { branch: fx.branch });

    const warns = logEvents(logPath).filter((e) => e["event"] === "indexer.pinned.local_edits_left_out");
    expect(warns).toHaveLength(1);
    expect(warns[0]).toMatchObject({ level: "warn", branch: fx.branch, dirty_files: 1, local_only_commits: 1 });
  });
});

describe("only a completed job from the remote counts as indexed", () => {
  beforeEach(() => {
    process.env["SCRYBE_EMBED_BATCH_SIZE"] = "2";
  });
  afterEach(() => {
    delete process.env["SCRYBE_EMBED_BATCH_SIZE"];
  });

  const scans = () => logEvents(logPath).filter((e) => e["event"] === "indexer.scan.completed").length;
  const tip = (fx: Fixture) => git(fx.clone, "rev-parse", `origin/${fx.branch}`);

  // Enough chunks that a job is still going after its first flush.
  function pushBigFile(fx: Fixture): void {
    let body = "";
    for (let i = 0; i < 8; i++) body += `export function big${i}(v: number): number {\n  return v + ${i};\n}\n\n`;
    commitFile(fx.other, "big.ts", body);
    git(fx.other, "push", "origin", `HEAD:${fx.branch}`);
    git(fx.clone, "fetch", "origin");
  }

  async function interrupted(p: TempProject, branch: string): Promise<void> {
    const { indexSource } = await import("../src/indexer.js");
    const controller = new AbortController();
    await expect(
      indexSource(p.projectId, p.sourceId, "incremental", {
        branch,
        signal: controller.signal,
        onProgress(r) {
          if (r.phase === "embed_batch") controller.abort();
        },
      })
    ).rejects.toThrow("INDEX_CANCELLED");
  }

  async function pin(p: TempProject, branch: string): Promise<void> {
    const { updateSource } = await import("../src/registry.js");
    updateSource(p.projectId, p.sourceId, { pinned_branches: [branch] });
  }

  it("(i) a last_indexed_sha at the tip with no remote record scans and replaces local content", async () => {
    const { fx, p } = await setup(false);
    const { indexSource } = await import("../src/indexer.js");
    const { setLastIndexedSha, getRemoteIndexedSha } = await import("../src/branch-state.js");
    await indexSource(p.projectId, p.sourceId, "incremental", { branch: fx.branch });
    expect(await indexedFiles(p, fx.branch)).toEqual(["a.ts", "dirty.ts", "local.ts"]);
    await pin(p, fx.branch);
    setLastIndexedSha(p.projectId, p.sourceId, fx.branch, tip(fx));
    const before = scans();

    await indexSource(p.projectId, p.sourceId, "incremental", { branch: fx.branch, contentRef: `origin/${fx.branch}` });

    expect(scans()).toBe(before + 1);
    expect(await indexedFiles(p, fx.branch)).toEqual(["a.ts", "remote.ts"]);
    expect(getRemoteIndexedSha(p.projectId, p.sourceId, fx.branch)).toBe(tip(fx));
  });

  it("(ii) an interrupted first index resumes, even with a baseline row written at the tip", async () => {
    const { fx, p } = await setup(true);
    const { indexSource } = await import("../src/indexer.js");
    const { setLastIndexedSha, getRemoteIndexedSha } = await import("../src/branch-state.js");
    pushBigFile(fx);
    await interrupted(p, fx.branch);
    expect(await indexedFiles(p, fx.branch)).not.toContain("big.ts");
    expect(getRemoteIndexedSha(p.projectId, p.sourceId, fx.branch)).toBeNull();
    setLastIndexedSha(p.projectId, p.sourceId, fx.branch, tip(fx));
    const before = scans();

    await indexSource(p.projectId, p.sourceId, "incremental", { branch: fx.branch });

    expect(scans()).toBe(before + 1);
    expect(await indexedFiles(p, fx.branch)).toEqual(["a.ts", "big.ts", "remote.ts"]);
  });

  it("(iii) after a successful job the next is a no-op", async () => {
    const { fx, p } = await setup(true);
    const { indexSource } = await import("../src/indexer.js");
    const { getRemoteIndexedSha } = await import("../src/branch-state.js");
    await indexSource(p.projectId, p.sourceId, "incremental", { branch: fx.branch });
    expect(getRemoteIndexedSha(p.projectId, p.sourceId, fx.branch)).toBe(tip(fx));
    const before = scans();

    const result = await indexSource(p.projectId, p.sourceId, "incremental", { branch: fx.branch });

    expect(result).toMatchObject({ files_scanned: 0, chunks_prepared: 0 });
    expect(scans()).toBe(before);
  });

  it("(iv) an interrupted job on a moved remote withdraws the record, so returning to the old tip still scans", async () => {
    const { fx, p } = await setup(true);
    const { indexSource } = await import("../src/indexer.js");
    const { getRemoteIndexedSha } = await import("../src/branch-state.js");
    await indexSource(p.projectId, p.sourceId, "incremental", { branch: fx.branch });
    const oldTip = tip(fx);

    pushBigFile(fx);
    await interrupted(p, fx.branch);
    expect(getRemoteIndexedSha(p.projectId, p.sourceId, fx.branch)).toBeNull();

    git(fx.clone, "update-ref", `refs/remotes/origin/${fx.branch}`, oldTip);
    const before = scans();
    await indexSource(p.projectId, p.sourceId, "incremental", { branch: fx.branch });
    expect(scans()).toBe(before + 1);
    expect(await indexedFiles(p, fx.branch)).toEqual(["a.ts", "remote.ts"]);
  });

  it("(v) a working-tree job withdraws the record, so pinning again re-reads the remote", async () => {
    const { fx, p } = await setup(true);
    const { indexSource } = await import("../src/indexer.js");
    const { updateSource } = await import("../src/registry.js");
    const { getRemoteIndexedSha } = await import("../src/branch-state.js");
    await indexSource(p.projectId, p.sourceId, "incremental", { branch: fx.branch });

    updateSource(p.projectId, p.sourceId, { pinned_branches: [] });
    await indexSource(p.projectId, p.sourceId, "incremental", { branch: fx.branch });
    expect(await indexedFiles(p, fx.branch)).toEqual(["a.ts", "dirty.ts", "local.ts"]);
    expect(getRemoteIndexedSha(p.projectId, p.sourceId, fx.branch)).toBeNull();

    await pin(p, fx.branch);
    await indexSource(p.projectId, p.sourceId, "incremental", { branch: fx.branch });
    expect(await indexedFiles(p, fx.branch)).toEqual(["a.ts", "remote.ts"]);
  });

  it("a changed private ignore rescans at the same SHA and drops the file's tags, then settles", async () => {
    const { fx, p } = await setup(true);
    const { indexSource } = await import("../src/indexer.js");
    const { savePrivateIgnore } = await import("../src/private-ignore.js");
    await indexSource(p.projectId, p.sourceId, "incremental", { branch: fx.branch });
    const sha = tip(fx);
    expect(await indexedFiles(p, fx.branch)).toEqual(["a.ts", "remote.ts"]);

    savePrivateIgnore(p.projectId, p.sourceId, "remote.ts\n");
    const before = scans();
    await indexSource(p.projectId, p.sourceId, "incremental", { branch: fx.branch });

    expect(scans()).toBe(before + 1);
    expect(tip(fx)).toBe(sha);
    expect(await indexedFiles(p, fx.branch)).toEqual(["a.ts"]);

    await indexSource(p.projectId, p.sourceId, "incremental", { branch: fx.branch });
    expect(scans()).toBe(before + 1);
  });

  it("a changed .scrybeignore at the root also rescans", async () => {
    const { fx, p } = await setup(true);
    const { indexSource } = await import("../src/indexer.js");
    await indexSource(p.projectId, p.sourceId, "incremental", { branch: fx.branch });

    writeFileSync(join(fx.clone, ".scrybeignore"), "remote.ts\n", "utf8");
    await indexSource(p.projectId, p.sourceId, "incremental", { branch: fx.branch });
    expect(await indexedFiles(p, fx.branch)).toEqual(["a.ts"]);
  });
});
