/**
 * A code file's tags and hash commit together once all its chunks are written, so an
 * interrupt cannot leave it truncated and it stays searchable meanwhile. `rechunk`
 * applies a chunker change to an existing index, touching only files that differ.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { execFileSync } from "child_process";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync, readFileSync, existsSync } from "fs";
import { join } from "path";
import { tmpdir } from "os";
import { createTempProject, type TempProject } from "./helpers/project.js";

const embedded = vi.hoisted(() => ({ texts: [] as string[] }));

// Fixed vectors: these tests are about tags and hashes, not retrieval.
vi.mock("../src/embedder.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../src/embedder.js")>();
  return {
    ...actual,
    embedBatched: async (texts: string[], cfg: { dimensions: number }) => {
      embedded.texts.push(...texts);
      return texts.map(() => new Array(cfg.dimensions).fill(0.1));
    },
  };
});

function git(cwd: string, ...args: string[]): string {
  return execFileSync(
    "git",
    ["-c", "core.hooksPath=/dev/null", "-c", "user.email=t@example.com", "-c", "user.name=t", ...args],
    { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }
  ).trim();
}

function fns(prefix: string, n: number): string {
  let out = "";
  for (let i = 0; i < n; i++) {
    out += `export function ${prefix}${i}(value: number): number {\n  const doubled = value * ${i + 2};\n  return doubled + ${i};\n}\n\n`;
  }
  return out;
}

interface Tag {
  chunk_id: string;
  start_line: number;
}

let root = "";
let project: TempProject | undefined;
let logPath = "";

function write(repo: string, rel: string, body: string): void {
  writeFileSync(join(repo, rel), body, "utf8");
}

async function setup(files: Record<string, string>): Promise<{ p: TempProject; repo: string; branch: string }> {
  const { resolveBranchForPath } = await import("../src/branch-state.js");
  const repo = join(root, "repo");
  mkdirSync(repo);
  git(repo, "init");
  for (const [rel, body] of Object.entries(files)) write(repo, rel, body);
  git(repo, "add", ".");
  git(repo, "commit", "-m", "seed");
  project = await createTempProject({ rootPath: repo });
  return { p: project, repo, branch: resolveBranchForPath(repo) };
}

type Db = ReturnType<typeof import("../src/branch-state.js")["getDB"]>;

function readTags(db: Db, p: TempProject, branch: string, file: string): Tag[] {
  return db
    .prepare("SELECT chunk_id, start_line FROM branch_tags WHERE project_id=? AND source_id=? AND branch=? AND file_path=? ORDER BY chunk_id")
    .all(p.projectId, p.sourceId, branch, file) as unknown as Tag[];
}

async function tagsOf(p: TempProject, branch: string, file: string): Promise<Tag[]> {
  const { getDB } = await import("../src/branch-state.js");
  return readTags(getDB(), p, branch, file);
}

function hashesOf(p: TempProject, branch: string): Record<string, string> {
  const path = join(process.env["SCRYBE_DATA_DIR"]!, "hashes", `${p.projectId}__${p.sourceId}__${branch}.json`);
  return JSON.parse(readFileSync(path, "utf8")) as Record<string, string>;
}

async function wantedIds(p: TempProject, file: string, body: string): Promise<string[]> {
  const { chunkFileContent } = await import("../src/plugins/code.js");
  const { getLanguage } = await import("../src/chunker.js");
  const lang = getLanguage(file) ?? "";
  return [...new Set(chunkFileContent(p.projectId, p.sourceId, file, body, lang).map((c) => c.chunk_id))].sort();
}

async function dropOneTagAddBogus(p: TempProject, branch: string, file: string): Promise<string> {
  const { getDB } = await import("../src/branch-state.js");
  const [victim] = await tagsOf(p, branch, file);
  getDB()
    .prepare("DELETE FROM branch_tags WHERE project_id=? AND source_id=? AND branch=? AND file_path=? AND chunk_id=?")
    .run(p.projectId, p.sourceId, branch, file, victim!.chunk_id);
  getDB()
    .prepare("INSERT INTO branch_tags (project_id, source_id, branch, file_path, chunk_id, start_line, end_line) VALUES (?, ?, ?, ?, 'bogus', 1, 2)")
    .run(p.projectId, p.sourceId, branch, file);
  return victim!.chunk_id;
}

function logEvents(): Record<string, any>[] {
  if (!existsSync(logPath)) return [];
  return readFileSync(logPath, "utf8").split("\n").filter(Boolean).map((l) => JSON.parse(l));
}

function lastSelection(): Record<string, any> | undefined {
  return logEvents().filter((e) => e["event"] === "indexer.rechunk.selected").at(-1);
}

const ids = (tags: Tag[]): string[] => tags.map((t) => t.chunk_id);

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "scrybe-file-commit-"));
  logPath = join(root, "daemon-log.jsonl");
  process.env["SCRYBE_DAEMON_LOG_PATH"] = logPath;
  process.env["SCRYBE_EMBED_BATCH_SIZE"] = "2";
  embedded.texts.length = 0;
});

afterEach(async () => {
  await project?.cleanup();
  project = undefined;
  delete process.env["SCRYBE_DAEMON_LOG_PATH"];
  delete process.env["SCRYBE_EMBED_BATCH_SIZE"];
  rmSync(root, { recursive: true, force: true });
});

describe("a file commits only when all its chunks are written", () => {
  it("an interrupt mid-file keeps the old hash and the old complete tags; the next run finishes it", async () => {
    const v1 = fns("oldFn", 8);
    const v2 = fns("newFn", 8);
    const { p, repo, branch } = await setup({ "big.ts": v1 });
    const { indexSource } = await import("../src/indexer.js");
    await indexSource(p.projectId, p.sourceId, "full", { branch });
    const oldTags = await tagsOf(p, branch, "big.ts");
    const oldHash = hashesOf(p, branch)["big.ts"];
    expect(oldTags.length).toBeGreaterThan(2);

    write(repo, "big.ts", v2);
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

    expect(hashesOf(p, branch)["big.ts"]).toBe(oldHash);
    expect(await tagsOf(p, branch, "big.ts")).toEqual(oldTags);

    await indexSource(p.projectId, p.sourceId, "incremental", { branch });
    expect(ids(await tagsOf(p, branch, "big.ts"))).toEqual(await wantedIds(p, "big.ts", v2));
    expect(hashesOf(p, branch)["big.ts"]).not.toBe(oldHash);
  });

  it("a changed file waiting its turn keeps its old tags", async () => {
    const { p, repo, branch } = await setup({ "one.ts": fns("oneOld", 4), "two.ts": fns("twoOld", 4) });
    const { indexSource } = await import("../src/indexer.js");
    await indexSource(p.projectId, p.sourceId, "full", { branch });
    const oldTags = { "one.ts": await tagsOf(p, branch, "one.ts"), "two.ts": await tagsOf(p, branch, "two.ts") };
    const oldHashes = hashesOf(p, branch);

    write(repo, "one.ts", fns("oneNew", 4));
    write(repo, "two.ts", fns("twoNew", 4));

    const { getDB } = await import("../src/branch-state.js");
    const db = getDB();
    let pendingSeen = 0;
    await indexSource(p.projectId, p.sourceId, "incremental", {
      branch,
      onProgress(r) {
        if (r.phase !== "embed_batch") return;
        const hashes = hashesOf(p, branch);
        for (const file of ["one.ts", "two.ts"] as const) {
          if (hashes[file] !== oldHashes[file]) continue;
          pendingSeen++;
          expect(readTags(db, p, branch, file)).toEqual(oldTags[file]);
        }
      },
    });
    expect(pendingSeen).toBeGreaterThan(0);
  });

  it("replace-all drops vanished chunks and refreshes the line of a chunk that moved", async () => {
    const keep = fns("keep", 1);
    const { p, repo, branch } = await setup({ "s.ts": fns("gone", 3) + keep });
    const { indexSource } = await import("../src/indexer.js");
    await indexSource(p.projectId, p.sourceId, "full", { branch });
    const [keepId] = await wantedIds(p, "s.ts", keep);
    const before = (await tagsOf(p, branch, "s.ts")).find((t) => t.chunk_id === keepId);
    expect(before?.start_line).toBeGreaterThan(1);

    write(repo, "s.ts", keep);
    await indexSource(p.projectId, p.sourceId, "incremental", { branch });
    expect(await tagsOf(p, branch, "s.ts")).toEqual([{ chunk_id: keepId, start_line: 1 }]);
  });

  it("a file that now yields no chunks has no tags and a saved hash", async () => {
    const { p, repo, branch } = await setup({ "e.ts": fns("was", 2), "other.ts": fns("other", 1) });
    const { indexSource } = await import("../src/indexer.js");
    await indexSource(p.projectId, p.sourceId, "full", { branch });
    const oldHash = hashesOf(p, branch)["e.ts"];
    expect((await tagsOf(p, branch, "e.ts")).length).toBeGreaterThan(0);

    write(repo, "e.ts", "\n\n");
    expect(await wantedIds(p, "e.ts", "\n\n")).toEqual([]);
    await indexSource(p.projectId, p.sourceId, "incremental", { branch });
    expect(await tagsOf(p, branch, "e.ts")).toEqual([]);
    expect(hashesOf(p, branch)["e.ts"]).toBeTruthy();
    expect(hashesOf(p, branch)["e.ts"]).not.toBe(oldHash);

    const again = await indexSource(p.projectId, p.sourceId, "incremental", { branch });
    expect(again).toMatchObject({ files_reindexed: 0, chunks_prepared: 0 });
  });

  it("files_reindexed counts a file spanning flushes once", async () => {
    const { p, branch } = await setup({ "big.ts": fns("span", 8) });
    const { indexSource } = await import("../src/indexer.js");
    const result = await indexSource(p.projectId, p.sourceId, "full", { branch });
    expect(result.files_reindexed).toBe(1);
  });

  it("gc asked for during a job waits for it and deletes nothing the job tagged", async () => {
    const { p, repo, branch } = await setup({ "big.ts": fns("oldFn", 6) });
    const { indexSource } = await import("../src/indexer.js");
    const { runGcJobHandler } = await import("../src/daemon/gc-handler.js");
    const { listChunkIds } = await import("../src/vector-store.js");
    const { getSource } = await import("../src/registry.js");
    await indexSource(p.projectId, p.sourceId, "full", { branch });

    write(repo, "big.ts", fns("newFn", 6));
    let gc: Promise<unknown> | undefined;
    let gcFinished = false;
    await indexSource(p.projectId, p.sourceId, "incremental", {
      branch,
      onProgress(r) {
        if (r.phase === "embed_batch" && !gc) {
          gc = runGcJobHandler({ projectId: p.projectId, sourceId: p.sourceId, mode: "purge" }).then(() => {
            gcFinished = true;
          });
        }
      },
    });
    expect(gcFinished).toBe(false);
    await gc;

    const inTable = new Set(await listChunkIds(p.projectId, getSource(p.projectId, p.sourceId)!.table_name!));
    const tagged = ids(await tagsOf(p, branch, "big.ts"));
    expect(tagged.length).toBeGreaterThan(0);
    expect(tagged.filter((id) => !inTable.has(id))).toEqual([]);
  });
});

describe("rechunk", () => {
  it("processes only files whose tags differ, embeds only what is unknown, and a second run selects nothing", async () => {
    const stale = fns("stale", 3);
    const fine = fns("fine", 3);
    const { p, branch } = await setup({ "stale.ts": stale, "fine.ts": fine });
    const { indexSource } = await import("../src/indexer.js");
    await indexSource(p.projectId, p.sourceId, "full", { branch });
    const fineBefore = await tagsOf(p, branch, "fine.ts");
    const hashesBefore = hashesOf(p, branch);
    await dropOneTagAddBogus(p, branch, "stale.ts");
    embedded.texts.length = 0;

    const first = await indexSource(p.projectId, p.sourceId, "rechunk", { branch });
    expect(lastSelection()).toMatchObject({ files_checked: 2, files_selected: 1 });
    expect(first.chunks_prepared).toBe((await wantedIds(p, "stale.ts", stale)).length);
    // Only the chunk whose tag was removed is unknown; the others keep their vectors.
    expect(embedded.texts).toHaveLength(1);
    expect(ids(await tagsOf(p, branch, "stale.ts"))).toEqual(await wantedIds(p, "stale.ts", stale));
    expect(await tagsOf(p, branch, "fine.ts")).toEqual(fineBefore);
    expect(hashesOf(p, branch)).toEqual(hashesBefore);

    embedded.texts.length = 0;
    const second = await indexSource(p.projectId, p.sourceId, "rechunk", { branch });
    expect(lastSelection()).toMatchObject({ files_checked: 2, files_selected: 0 });
    expect(second).toMatchObject({ files_reindexed: 0, chunks_prepared: 0 });
    expect(embedded.texts).toHaveLength(0);
  });

  it("a file the normal diff already picked is reindexed without being compared", async () => {
    const { p, repo, branch } = await setup({ "a.ts": fns("aOld", 2), "b.ts": fns("b", 2) });
    const { indexSource } = await import("../src/indexer.js");
    await indexSource(p.projectId, p.sourceId, "full", { branch });
    const aNew = fns("aNew", 2);
    write(repo, "a.ts", aNew);

    await indexSource(p.projectId, p.sourceId, "rechunk", { branch });
    expect(lastSelection()).toMatchObject({ files_checked: 1, files_selected: 0 });
    expect(ids(await tagsOf(p, branch, "a.ts"))).toEqual(await wantedIds(p, "a.ts", aNew));
  });

  it("cancelled partway and run again, it finishes and leaves everything matching", async () => {
    const bodies = { "x.ts": fns("x", 3), "y.ts": fns("y", 3), "z.ts": fns("z", 3) };
    const { p, branch } = await setup(bodies);
    const { indexSource } = await import("../src/indexer.js");
    await indexSource(p.projectId, p.sourceId, "full", { branch });
    for (const file of Object.keys(bodies)) await dropOneTagAddBogus(p, branch, file);

    const controller = new AbortController();
    await expect(
      indexSource(p.projectId, p.sourceId, "rechunk", {
        branch,
        signal: controller.signal,
        onProgress(r) {
          if (r.phase === "embed_batch") controller.abort();
        },
      })
    ).rejects.toThrow("INDEX_CANCELLED");

    await indexSource(p.projectId, p.sourceId, "rechunk", { branch });
    for (const [file, body] of Object.entries(bodies)) {
      expect(ids(await tagsOf(p, branch, file))).toEqual(await wantedIds(p, file, body));
    }
    await indexSource(p.projectId, p.sourceId, "rechunk", { branch });
    expect(lastSelection()).toMatchObject({ files_checked: 3, files_selected: 0 });
  });

  it("on a pinned branch it runs despite an unchanged SHA; a plain incremental right after short-circuits", async () => {
    const seed = join(root, "seed");
    mkdirSync(seed);
    git(seed, "init");
    const body = fns("pinned", 3);
    write(seed, "a.ts", body);
    git(seed, "add", ".");
    git(seed, "commit", "-m", "seed");
    const origin = join(root, "origin.git");
    git(root, "clone", "--bare", seed, origin);
    const clone = join(root, "clone");
    git(root, "clone", origin, clone);

    const { resolveBranchForPath } = await import("../src/branch-state.js");
    const branch = resolveBranchForPath(clone);
    project = await createTempProject({ rootPath: clone });
    const p = project;
    const { updateSource } = await import("../src/registry.js");
    updateSource(p.projectId, p.sourceId, { pinned_branches: [branch] });

    const { indexSource } = await import("../src/indexer.js");
    await indexSource(p.projectId, p.sourceId, "incremental", { branch });
    await dropOneTagAddBogus(p, branch, "a.ts");

    const result = await indexSource(p.projectId, p.sourceId, "rechunk", { branch });
    expect(result.files_scanned).toBeGreaterThan(0);
    expect(lastSelection()).toMatchObject({ files_checked: 1, files_selected: 1 });
    expect(ids(await tagsOf(p, branch, "a.ts"))).toEqual(await wantedIds(p, "a.ts", body));

    const after = await indexSource(p.projectId, p.sourceId, "incremental", { branch });
    expect(after).toMatchObject({ files_scanned: 0, files_reindexed: 0 });
    expect(logEvents().filter((e) => e["event"] === "indexer.job.summary").at(-1)?.["unchanged_sha"]).toBeTruthy();
  });

  it("on a knowledge source it throws a clear error", async () => {
    const { addProject, addSource } = await import("../src/registry.js");
    addProject({ id: "kp", description: "knowledge only" });
    addSource("kp", {
      source_id: "issues",
      source_config: { type: "ticket", provider: "github", base_url: "http://x", project_id: "1", token: "t" } as never,
    });
    const { indexSource } = await import("../src/indexer.js");
    await expect(indexSource("kp", "issues", "rechunk")).rejects.toThrow(/rechunk only applies to code sources/);
  });
});
