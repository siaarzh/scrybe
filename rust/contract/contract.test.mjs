// Same call, same answer: every test here passes against today's TypeScript build, and is written so
// the Rust build can be held to it. A tool a build doesn't have yet shows as skipped, not passed.
import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { createServer as createHttpServer, request as httpRequest } from "node:http";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execFileSync, spawn } from "node:child_process";
import { DatabaseSync } from "node:sqlite";
import { after, afterEach, before, beforeEach, describe, test } from "node:test";
import { pathToFileURL } from "node:url";
import { BUILD, CLI, GITHUB_PROJECT, GITHUB_TOKEN, GITLAB_PROJECT, GITLAB_TOKEN, LOCAL_MODEL, RELAY, SERVER, fakeEmbedder, fakeGithub, fakeModelHost, fakeReranker, rerankScoreFor, useLocalModel, fakeGitlab, makeWorld, sleep, until, vectorFor } from "./harness.mjs";

// Rows the TypeScript build wrote for the fixture trackers below, with the second one's addition after an edit.
const GITLAB_ROWS = JSON.parse(readFileSync(new URL("./gitlab-rows.json", import.meta.url), "utf8"));
const GITHUB_ROWS = JSON.parse(readFileSync(new URL("./github-rows.json", import.meta.url), "utf8"));
const byId = (a, b) => (a.chunk_id < b.chunk_id ? -1 : a.chunk_id > b.chunk_id ? 1 : 0);
const EXPECTED_FULL = [...GITLAB_ROWS.full].sort(byId);
const EXPECTED_AFTER_CHANGE = [...GITLAB_ROWS.full, ...GITLAB_ROWS.addedByChange].sort(byId);
const GITHUB_FULL = [...GITHUB_ROWS.full].sort(byId);
const GITHUB_AFTER_CHANGE = [...GITHUB_ROWS.full, ...GITHUB_ROWS.addedByChange].sort(byId);

// Behaviour the Rust build doesn't match yet. Listed as todo, so they run and report without failing the run.
const RUST_GAPS = new Set([]);
const gap = (name) => (BUILD === "rust" && RUST_GAPS.has(name) ? { todo: "not matched by the Rust build yet" } : {});

const post = async (base, path) => (await fetch(base + path, { method: "POST" })).json();

const hasFields = (obj, fields) => {
  for (const f of fields) assert.ok(f in obj, `missing field ${f}: ${JSON.stringify(obj).slice(0, 300)}`);
};

describe("the handshake", () => {
  let w;
  before(async () => { w = await makeWorld(); });
  after(() => w.stop());

  test("needs no server, and starts none", async () => {
    const c = w.client();
    const m = await c.hello("2025-06-18");
    assert.equal(m.result.protocolVersion, "2025-06-18");
    assert.equal(m.result.serverInfo.name, "scrybe");
    assert.equal(m.result.capabilities.tools.listChanged, true);
    assert.equal(w.pidfile(), null);
  });

  test("offers the newest protocol when asked for an unknown one", async () => {
    const m = await w.client().hello("1999-01-01");
    assert.match(m.result.protocolVersion, /^\d{4}-\d{2}-\d{2}$/);
    assert.notEqual(m.result.protocolVersion, "1999-01-01");
  });

  test("answers ping, refuses unknown methods and survives junk", async () => {
    const c = w.client();
    await c.hello();
    assert.deepEqual((await c.rpc("ping")).result, {});
    assert.equal((await c.rpc("resources/list")).error.code, -32601);
    c.raw("this is not json");
    assert.deepEqual((await c.rpc("ping")).result, {});
  });
});

describe("the tools", () => {
  let w, c, names;
  const skipUnlessPorted = (t, tool) => {
    if (!names.includes(tool)) { t.skip(`${BUILD} has no ${tool} yet`); return true; }
    return false;
  };
  before(async () => {
    w = await makeWorld();
    await w.index("--full");
    c = w.client();
    await c.hello();
    names = await c.toolNames();
  });
  after(() => w.stop());

  test("the tool list carries schemas", async () => {
    const m = await c.rpc("tools/list");
    for (const name of ["list_projects", "search_code", "search_knowledge", "lookup_symbol"]) {
      const tool = m.result.tools.find((t) => t.name === name);
      assert.ok(tool, `no ${name}`);
      assert.equal(tool.inputSchema.type, "object");
      assert.ok(tool.description.length > 10);
    }
  });

  test("list_projects shows the project and its source", async () => {
    const { value } = await c.call("list_projects");
    const demo = value.find((p) => p.id === "demo");
    assert.equal(demo.description, "A demo");
    assert.equal(demo.sources[0].source_id, "primary");
  });

  test("search_code finds code by keyword, with its location", async () => {
    const { value, isError } = await c.call("search_code", { project_id: "demo", query: "frobnicateWidget", top_k: 5 });
    assert.equal(isError, false);
    assert.ok(value.length >= 1 && value.length <= 5);
    hasFields(value[0], ["chunk_id", "score", "project_id", "source_id", "item_path", "start_line", "end_line", "language", "symbol_name", "content"]);
    // The fake vectors mean nothing, so only the keyword side is expected to find it.
    const hit = value.find((h) => h.symbol_name === "frobnicateWidget");
    assert.equal(hit.item_path, "src/widget.ts");
    assert.equal(hit.language, "typescript");
  });

  test("search_code respects top_k and never returns ignored files", async () => {
    const { value } = await c.call("search_code", { project_id: "demo", query: "shouldNeverBeFound", top_k: 1 });
    assert.equal(value.length, 1);
    const all = (await c.call("search_code", { project_id: "demo", query: "shouldNeverBeFound", top_k: 50 })).value;
    assert.ok(!all.some((h) => h.item_path.startsWith("notes/") || h.item_path.startsWith("docs/")));
  });

  test("the same search gives the same answer twice", async () => {
    const q = { project_id: "demo", query: "calibrate gadget level", top_k: 5 };
    assert.equal((await c.call("search_code", q)).text, (await c.call("search_code", q)).text);
  });

  test("an unknown project is a clean error", async () => {
    const r = await c.call("search_code", { project_id: "nope", query: "x" });
    assert.ok(r.isError || r.rpcError, JSON.stringify(r));
    assert.match(r.text ?? r.rpcError.message, /Project 'nope' not found/);
  });

  test("an internal fault is not shown to the caller", async () => {
    const r = await c.call("lookup_symbol", { project_id: "nope", symbol_name: "x" });
    assert.ok(r.isError, JSON.stringify(r));
    assert.deepEqual(r.value, { error: "internal error" });
  });

  test("a missing required argument is a clean error", async () => {
    const r = await c.call("search_code", { project_id: "demo" });
    assert.ok(r.isError || r.rpcError, JSON.stringify(r));
    assert.match(r.text ?? r.rpcError.message, /query/);
  });

  test("a wrong argument name gets a did-you-mean", gap("a wrong argument name gets a did-you-mean"), async () => {
    const r = await c.call("search_code", { project_ids: ["demo"], query: "x" });
    assert.ok(r.isError || r.rpcError, JSON.stringify(r));
    assert.match(r.text ?? r.rpcError.message, /project_id\b/);
    assert.match(r.text ?? r.rpcError.message, /did you mean|project_ids/i);
  });

  test("an unknown tool is reported", gap("an unknown tool is reported"), async () => {
    const r = await c.call("no_such_tool");
    assert.ok(r.isError || r.rpcError, JSON.stringify(r));
    assert.match(r.text ?? r.rpcError.message, /no_such_tool/);
  });

  test("search_knowledge on a code-only project names the right tool", async () => {
    const r = await c.call("search_knowledge", { project_id: "demo", query: "x" });
    assert.match(r.text ?? r.rpcError.message, /search_code/);
  });

  test("lookup_symbol finds exact and suffix names, sorted, without scores", async () => {
    const suffix = (await c.call("lookup_symbol", { project_id: "demo", symbol_name: "addWidget" })).value;
    assert.equal(suffix.length, 1);
    assert.equal(suffix[0].symbol_name, "WidgetStore.addWidget");
    assert.ok(!("score" in suffix[0]));
    const exact = (await c.call("lookup_symbol", { project_id: "demo", symbol_name: "addWidget", match: "exact" })).value;
    assert.equal(exact.length, 0);
    const full = (await c.call("lookup_symbol", { project_id: "demo", symbol_name: "WidgetStore.addWidget", match: "exact" })).value;
    assert.equal(full.length, 1);
  });

  test("lookup_symbol can ignore case, and honours its limit", async () => {
    assert.equal((await c.call("lookup_symbol", { project_id: "demo", symbol_name: "FROBNICATEWIDGET" })).value.length, 0);
    assert.equal((await c.call("lookup_symbol", { project_id: "demo", symbol_name: "FROBNICATEWIDGET", case_sensitive: false })).value.length, 1);
    assert.ok((await c.call("lookup_symbol", { project_id: "demo", symbol_name: "mount", limit: 1 })).value.length <= 1);
  });

  test("nine calls at once all come back under the right ids", async () => {
    const queries = Array.from({ length: 9 }, (_, i) => c.call("search_code", { project_id: "demo", query: `widget ${i}`, top_k: 1 }));
    for (const r of await Promise.all(queries)) assert.equal(r.value.length, 1);
  });

  for (const [tool, args, fields] of [
    ["list_sources", { project_id: "demo" }, null],
    ["list_branches", { project_id: "demo" }, null],
    ["list_pinned_branches", { project_id: "demo" }, null],
    ["list_jobs", {}, null],
    ["queue_status", {}, null],
    ["status", {}, ["version"]],
  ]) {
    test(`${tool} answers`, async (t) => {
      if (skipUnlessPorted(t, tool)) return;
      const r = await c.call(tool, args);
      assert.ok(!r.isError && !r.rpcError, JSON.stringify(r).slice(0, 400));
      if (fields) hasFields(r.value, fields);
    });
  }

  test("a job can be followed, listed and looked up", async (t) => {
    if (skipUnlessPorted(t, "reindex_source")) return;
    const started = await c.call("reindex_source", { project_id: "demo", source_id: "primary" });
    assert.equal(started.value.project_id, "demo");
    assert.equal(started.value.source_id, "primary");
    assert.equal(started.value.mode, "incremental");
    const id = started.value.job_id;
    const done = await until(async () => {
      const s = (await c.call("reindex_status", { job_id: id })).value;
      return ["done", "failed"].includes(s?.status) && s;
    }, 60_000, "the job");
    assert.equal(done.status, "done", JSON.stringify(done));
    assert.equal(done.tasks[0].source_id, "primary");
    assert.equal(done.tasks[0].status, "done");
    assert.ok(done.finished_at >= done.started_at);
    const listed = (await c.call("list_jobs")).value;
    assert.equal(listed.count, listed.jobs.length);
    assert.ok(listed.jobs.some((j) => j.job_id === id));
    assert.equal((await c.call("cancel_reindex", { job_id: id })).value.cancelled, false);
    const q = (await c.call("queue_status", { project_id: "demo" })).value;
    assert.deepEqual(q.running, []);
    assert.deepEqual(q.queued, []);
    assert.deepEqual(q.awaiting_migration, []);
  });

  test("a full reindex without sources is refused, and a job for no project is masked", async (t) => {
    if (skipUnlessPorted(t, "reindex_project")) return;
    assert.ok((await c.call("reindex_project", { project_id: "demo", mode: "full" })).isError);
    assert.ok((await c.call("reindex_status", { job_id: "nope" })).isError);
  });

  test("status reports the server and the configured model", async (t) => {
    if (skipUnlessPorted(t, "status")) return;
    const s = (await c.call("status")).value;
    assert.equal(s.daemon_running, true);
    assert.equal(s.daemon_pid, w.pidfile().pid);
    assert.equal(s.daemon_port, w.pidfile().port);
    assert.equal(s.code_model, "fake-model");
    assert.equal(s.code_provider_type, "api");
    assert.equal(s.api_key_present, true);
    assert.equal(s.config_present, true);
  });

  test("the HTTP routes the extension and hooks use answer in the same shapes", async (t) => {
    if (skipUnlessPorted(t, "status")) return;
    const base = `http://127.0.0.1:${w.pidfile().port}`;
    const get = async (p) => (await fetch(base + p)).json();
    const health = await get("/health");
    assert.equal(health.ready, true);
    assert.equal(health.draining, false);
    assert.equal(health.pid, w.pidfile().pid);
    const status = await get("/status");
    for (const f of ["version", "pid", "port", "uptimeMs", "state", "startedAt", "dataDir", "projects", "queue", "recentEvents", "draining", "clientCount", "mode", "runningJobs"]) assert.ok(f in status, f);
    assert.equal(status.projects[0].projectId, "demo");
    assert.equal(status.mode, "always-on");
    assert.equal(typeof status.clientCount, "number");
    assert.equal((await get("/projects")).projects[0].id, "demo");
    assert.deepEqual(Object.keys(await get("/queue-status")).sort(), ["awaiting_migration", "queued", "running"]);
    assert.equal((await get("/jobs")).count >= 1, true);
    assert.equal((await fetch(`${base}/jobs/nope`)).status, 404);
    assert.equal((await fetch(`${base}/nope`)).status, 404);
    assert.equal((await fetch(`${base}/mcp`)).status, 404);
    const kicked = await (await fetch(`${base}/kick`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ projectId: "demo" }) })).json();
    assert.equal(kicked.jobs[0].projectId, "demo");
    assert.equal(kicked.jobs[0].sourceId, "all");
    assert.equal(kicked.jobs[0].branch, "HEAD");
    assert.equal((await post(base, "/pause")).state, "paused");
    assert.equal((await post(base, "/resume")).state, "hot");
    const refused = await new Promise((resolve) => {
      const r = httpRequest(`${base}/status`, { headers: { Host: "evil.example" } }, (res) => { res.resume(); resolve(res.statusCode); });
      r.end();
    });
    assert.equal(refused, 403);
    assert.equal((await fetch(`${base}/status`, { headers: { Origin: "http://evil.example" } })).status, 403);
  });

  test("pin_branches and unpin_branches change the list", async (t) => {
    if (skipUnlessPorted(t, "pin_branches")) return;
    await c.call("pin_branches", { project_id: "demo", source_id: "primary", branches: ["side"] });
    assert.match((await c.call("list_pinned_branches", { project_id: "demo" })).text, /side/);
    await c.call("unpin_branches", { project_id: "demo", source_id: "primary", branches: ["side"] });
    assert.doesNotMatch((await c.call("list_pinned_branches", { project_id: "demo" })).text, /side/);
  });

  test("the pinned-branches HTTP routes list, add, remove and refuse in the same shapes", async () => {
    const base = `http://127.0.0.1:${w.pidfile().port}`;
    const url = (p = "demo", s = "primary") => `${base}/projects/${p}/sources/${s}/pinned-branches`;
    const send = async (method, u, body) => {
      const res = await fetch(u, { method, headers: { "Content-Type": "application/json" }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
      return { status: res.status, body: await res.json() };
    };
    const feed = await watchEvents(base);
    try {
      assert.deepEqual(await send("GET", url()), { status: 200, body: { branches: [] } });
      const added = await send("POST", url(), { branches: ["zeta", "side"] });
      assert.equal(added.status, 200);
      assert.deepEqual(added.body.branches, ["zeta", "side"]);
      assert.deepEqual(added.body.added, ["zeta", "side"]);
      assert.deepEqual(added.body.warnings, []);
      assert.deepEqual((await send("POST", url(), { branches: ["side", "extra"] })).body.added, ["extra"]);
      assert.deepEqual((await send("POST", url(), { branches: ["only"], mode: "set" })).body.branches, ["only"]);
      assert.deepEqual((await send("GET", url())).body, { branches: ["only"] });
      assert.deepEqual((await send("DELETE", url(), { branches: ["only", "never"] })).body, { branches: [], removed: ["only"] });
      await send("POST", url(), { branches: ["a", "b"] });
      assert.deepEqual((await send("DELETE", `${url()}?all=true`)).body, { branches: [], removed: ["a", "b"] });
      const noProject = await send("GET", url("nope"));
      assert.equal(noProject.status, 404);
      assert.equal(noProject.body.error_type, "project_not_found");
      assert.equal(noProject.body.error, "Project 'nope' not found");
      const noSource = await send("POST", url("demo", "nope"), { branches: ["x"] });
      assert.equal(noSource.status, 404);
      assert.equal(noSource.body.error_type, "source_not_found");
      assert.equal(noSource.body.error, "Source 'nope' not found in project 'demo'");
      assert.equal((await send("PUT", url(), {})).status, 404);
      const changes = await until(async () => {
        const seen = feed.events.filter((e) => e.event === "pinned.changed");
        return seen.length >= 6 && seen;
      }, 10_000, "the pinned.changed events");
      assert.deepEqual(changes.slice(0, 2).map((e) => e.detail), [{ action: "add", branches: ["zeta", "side"] }, { action: "add", branches: ["extra"] }]);
      assert.equal(changes[0].projectId, "demo");
      assert.equal(changes[0].sourceId, "primary");
      assert.equal(changes[0].level, "info");
      assert.deepEqual(changes[5].detail, { action: "remove", branches: ["a", "b"] });
    } finally {
      feed.stop();
    }
  });

  test("pin_branches reports a branch with no ignore rules, and a long list", async (t) => {
    if (skipUnlessPorted(t, "pin_branches")) return;
    const first = (await c.call("pin_branches", { project_id: "demo", source_id: "primary", branches: ["warned"] })).value;
    assert.deepEqual(first.branches, ["warned"]);
    assert.deepEqual(first.added, ["warned"]);
    assert.equal(first.ignore_warnings.length, 1);
    assert.match(first.ignore_warnings[0], /^warning: branch 'warned' has no \.scrybeignore and source 'demo\/primary' has no private ignore\.\n/);
    const many = Array.from({ length: 21 }, (_, i) => `b${i}`);
    const set = (await c.call("pin_branches", { project_id: "demo", branches: many, mode: "set" })).value;
    assert.equal(set.branches.length, 21);
    assert.equal(set.warnings.length, 1);
    assert.match(set.warnings[0], /has 21 pinned branches\./);
    const gone = (await c.call("unpin_branches", { project_id: "demo", branches: [...many, "warned"] })).value;
    assert.deepEqual(gone.branches, []);
    assert.equal(gone.removed.length, 21);
    const listed = (await c.call("list_pinned_branches", { project_id: "demo", source_id: "primary" })).value;
    assert.deepEqual(listed, [{ source_id: "primary", branches: [] }]);
    assert.deepEqual((await c.call("list_pinned_branches", { project_id: "demo", source_id: "nope" })).value, []);
    const bad = await c.call("pin_branches", { project_id: "nope", branches: ["x"] });
    assert.ok(bad.isError || bad.rpcError, JSON.stringify(bad));
  });

  test("private ignore rules can be set, read and cleared", async (t) => {
    if (skipUnlessPorted(t, "set_private_ignore")) return;
    await c.call("set_private_ignore", { project_id: "demo", source_id: "primary", content: "secret/\n" });
    assert.match((await c.call("get_private_ignore", { project_id: "demo", source_id: "primary" })).text, /secret/);
    assert.match((await c.call("list_private_ignores", { project_id: "demo" })).text, /primary/);
  });

  test("projects can be added, updated and removed", async (t) => {
    if (skipUnlessPorted(t, "add_project")) return;
    await c.call("add_project", { project_id: "second", description: "two" });
    assert.ok((await c.call("list_projects")).value.some((p) => p.id === "second"));
    await c.call("update_project", { project_id: "second", description: "changed" });
    assert.equal((await c.call("list_projects")).value.find((p) => p.id === "second").description, "changed");
    await c.call("remove_project", { project_id: "second" });
    assert.ok(!(await c.call("list_projects")).value.some((p) => p.id === "second"));
  });

  test("reindex_project runs as a job the client can follow", async (t) => {
    if (skipUnlessPorted(t, "reindex_project")) return;
    writeFileSync(join(w.repo, "src/added_by_job.ts"), "export function addedByTheJob() { return 1; }\n");
    const started = await c.call("reindex_project", { project_id: "demo" });
    const id = started.value.job_id;
    assert.ok(id, JSON.stringify(started));
    await until(async () => {
      const s = (await c.call("reindex_status", { job_id: id })).value;
      return ["done", "completed", "failed", "cancelled"].includes(s?.status) && s;
    }, 90_000, "the reindex job");
    assert.equal((await c.call("lookup_symbol", { project_id: "demo", symbol_name: "addedByTheJob" })).value.length, 1);
    rmSync(join(w.repo, "src/added_by_job.ts"));
  });
});

describe("indexing", () => {
  let w, c;
  before(async () => {
    w = await makeWorld();
    await w.index("--full");
    c = w.client();
    await c.hello();
    await c.rpc("tools/list");
  });
  after(() => w.stop());
  const find = async (symbol, extra = {}) => (await c.call("lookup_symbol", { project_id: "demo", symbol_name: symbol, ...extra })).value;
  const restartServer = async () => {
    const pf = w.pidfile();
    if (pf) {
      process.kill(pf.pid, "SIGKILL");
      await sleep(300);
    }
  };

  test("the embedding endpoint got the key, and nothing was indexed twice", async () => {
    assert.ok(w.fake.log.length > 0);
    assert.equal(w.fake.log[0].auth, "Bearer contract-key");
    const before = w.fake.log.length;
    await w.index();
    assert.equal(w.fake.log.length, before, "an unchanged repo must not embed anything");
  });

  test("the registry, hash files and tables are where they belong", () => {
    const projects = JSON.parse(readFileSync(join(w.data, "projects.json"), "utf8"));
    const source = projects[0].sources[0];
    assert.match(source.table_name, /^code_[0-9a-f]{12}$/);
    assert.ok(source.last_indexed);
    const hashes = JSON.parse(readFileSync(join(w.data, "hashes", `demo__primary__${w.main.replace(/\//g, "__")}.json`), "utf8"));
    assert.deepEqual(Object.keys(hashes).sort(), ["src/gadget.py", "src/widget.ts"]);
    readFileSync(join(w.data, "lancedb", `${source.table_name}-meta.json`), "utf8");
    readFileSync(join(w.data, "cursors", "demo__primary.json"), "utf8");
  });

  test("an edit, a new file and a deletion are picked up", async () => {
    writeFileSync(join(w.repo, "src/widget.ts"), readFileSync(join(w.repo, "src/widget.ts"), "utf8") + "\nexport function addedLater() { return 2; }\n");
    writeFileSync(join(w.repo, "src/brand_new.py"), "def brand_new_function():\n    return 1\n");
    rmSync(join(w.repo, "src/gadget.py"));
    await w.index();
    await restartServer();
    assert.equal((await find("addedLater")).length, 1);
    assert.equal((await find("brand_new_function")).length, 1);
    // A deleted file's row stays until garbage collection, but it's gone from the branch.
    assert.equal((await find("calibrate_gadget", { branch: w.main })).length, 0);
  });

  test("a branch that isn't checked out indexes from git, under its own name", async () => {
    await w.index("--branch", "side");
    await restartServer();
    assert.equal((await find("onlyOnTheSideBranch", { branch: "side" })).length, 1);
    assert.equal((await find("onlyOnTheSideBranch", { branch: w.main })).length, 0);
    const search = await c.call("search_code", { project_id: "demo", query: "onlyOnTheSideBranch", branch: "side", top_k: 3 });
    assert.equal(search.value[0].item_path, "src/side_only.ts");
  });

  test("a branch that doesn't exist fails with a useful message", async () => {
    const r = await w.cli("index", "-P", "demo", "-S", "primary", "--branch", "no-such-branch");
    assert.notEqual(r.status, 0);
    assert.match(r.stderr + r.stdout, /no-such-branch.*not found locally/);
  });

  test("a full run rebuilds a table whose files are gone", async () => {
    const table = JSON.parse(readFileSync(join(w.data, "projects.json"), "utf8"))[0].sources[0].table_name;
    await restartServer();
    rmSync(join(w.data, "lancedb", `${table}.lance`, "data"), { recursive: true, force: true });
    await w.index("--full");
    assert.equal((await find("frobnicateWidget")).length, 1);
    assert.match(readFileSync(join(w.data, "daemon-log.jsonl"), "utf8"), /health\.repaired-via-rebuild/);
  });
});

describe("the tiny client and the server's lifetime", () => {
  let w;
  before(async () => { w = await makeWorld(); await w.index("--full"); });
  after(() => w.stop());

  test("three clients at once start exactly one server", async () => {
    const cs = [w.client(), w.client(), w.client()];
    await Promise.all(cs.map((c) => c.hello()));
    const lists = await Promise.all(cs.map((c) => c.rpc("tools/list")));
    for (const l of lists) assert.ok(l.result.tools.length > 3, JSON.stringify(l).slice(0, 300));
    await until(() => w.health(), 30_000, "a healthy server");
    const r = await cs[1].call("lookup_symbol", { project_id: "demo", symbol_name: "frobnicateWidget" });
    assert.equal(r.value.length, 1);
  });

  test("the next call after the server dies starts a new one", async () => {
    const c = w.client();
    await c.hello();
    await c.rpc("tools/list");
    const old = w.pidfile().pid;
    process.kill(old, "SIGKILL");
    await sleep(300);
    const r = await c.call("search_code", { project_id: "demo", query: "frobnicateWidget", top_k: 1 });
    assert.equal(r.isError, false, r.text);
    assert.equal(r.value.length, 1);
    assert.notEqual(w.pidfile().pid, old);
  });

  test("with no server and no way to start one: a small tool list, then a notice when it arrives", async () => {
    await w.killServer();
    const c = w.client({ start: [process.execPath, "-e", "process.exit(1)"], extraEnv: { SCRYBE_MCP_COLD_START_WAIT_MS: "1000" } });
    await c.hello();
    const names = (await c.rpc("tools/list")).result.tools.map((t) => t.name).sort();
    assert.deepEqual(names, ["doctor", "init", "status"]);
    assert.equal((await c.call("status")).value.daemon_running, false);
    assert.equal((await c.call("search_code", { project_id: "demo", query: "x" })).isError, true);
    const starter = w.client();
    await starter.hello();
    await starter.rpc("tools/list");
    await until(() => c.notes.includes("notifications/tools/list_changed"), 20_000, "the list_changed notice");
    assert.ok((await c.rpc("tools/list")).result.tools.length > 3);
  });

  test("SCRYBE_NO_AUTO_DAEMON stops it starting anything", async () => {
    await w.killServer();
    const c = w.client({ extraEnv: { SCRYBE_NO_AUTO_DAEMON: "1", SCRYBE_MCP_COLD_START_WAIT_MS: "500" } });
    await c.hello();
    await c.rpc("tools/list");
    await sleep(1000);
    assert.equal(w.pidfile(), null);
  });
});

describe("indexing by itself", () => {
  const quick = { SCRYBE_DAEMON_FS_DEBOUNCE_MS: "100", SCRYBE_DAEMON_GIT_DEBOUNCE_MS: "100", SCRYBE_DAEMON_COLD_MULTIPLIER: "1", SCRYBE_DAEMON_NO_FETCH: "", SCRYBE_DAEMON_FETCH_ACTIVE_MS: "1000", SCRYBE_DAEMON_FETCH_IDLE_MS: "1000" };
  let w, c;
  before(async () => {
    w = await makeWorld({ serverEnv: quick, pinned: ["side"], withOrigin: true });
    await w.index("--full");
    c = w.client();
    await c.hello();
    await c.rpc("tools/list");
    // Watchers start with the server; give them a moment to subscribe.
    await sleep(1500);
  });
  after(() => w.stop());
  const found = (name, extra = {}) => async () => (await c.call("lookup_symbol", { project_id: "demo", symbol_name: name, ...extra })).value?.length > 0;

  test("saving a file indexes it", async (t) => {
    const names = await c.toolNames();
    if (!names.includes("gc")) return t.skip("not ported");
    writeFileSync(join(w.repo, "src/saved_later.ts"), "export function savedWhileRunning() { return 7; }\n");
    await until(found("savedWhileRunning"), 30_000, "the saved file to be indexed");
  });

  test("switching branches indexes the new one", async (t) => {
    const names = await c.toolNames();
    if (!names.includes("gc")) return t.skip("not ported");
    rmSync(join(w.repo, "src/saved_later.ts"));
    w.git("checkout", "-q", "side");
    await until(found("onlyOnTheSideBranch", { branch: "side" }), 30_000, "the branch to be indexed");
    w.git("checkout", "-q", w.main);
  });

  test("a pinned branch follows its remote", async (t) => {
    const names = await c.toolNames();
    if (!names.includes("gc")) return t.skip("not ported");
    writeFileSync(join(w.origin, "src/from_upstream.py"), "def arrived_from_upstream():\n    return 1\n");
    w.originGit("add", "src/from_upstream.py");
    w.originGit("commit", "-q", "-m", "upstream");
    await until(found("arrived_from_upstream", { branch: "side" }), 30_000, "the upstream commit to be indexed");
  });

  test("garbage collection removes rows no branch refers to", async (t) => {
    const names = await c.toolNames();
    if (!names.includes("gc")) return t.skip("not ported");
    await until(async () => (await c.call("queue_status")).value.running.length === 0, 30_000, "the queue to settle");
    rmSync(join(w.repo, "src/widget.ts"));
    await until(async () => (await c.call("lookup_symbol", { project_id: "demo", symbol_name: "frobnicateWidget", branch: w.main })).value.length === 0, 30_000, "the deletion to be noticed");
    await until(async () => (await c.call("queue_status")).value.running.length === 0, 30_000, "the queue to settle");
    // The side branch still has this file, so only removing that branch's tags could orphan it.
    const started = await c.call("gc", { project_id: "demo" });
    assert.match(started.value.message, /1 gc job\(s\) queued/);
    const id = started.value.jobs[0].job_id;
    const done = await until(async () => {
      const s = (await c.call("reindex_status", { job_id: id })).value;
      return ["done", "failed"].includes(s?.status) && s;
    }, 30_000, "the gc job");
    assert.equal(done.status, "done", JSON.stringify(done));
    assert.equal(done.type, "gc");
    const result = JSON.parse(done.result);
    for (const f of ["orphans_deleted", "bytes_freed", "duration_ms"]) assert.equal(typeof result[f], "number");
  });
});

/** Collects the server's event stream from the start of its memory. */
async function watchEvents(base) {
  const events = [];
  const ctl = new AbortController();
  const res = await fetch(`${base}/events?since=1970-01-01T00:00:00.000Z`, { signal: ctl.signal });
  (async () => {
    let buf = "";
    try {
      for await (const chunk of res.body) {
        buf += Buffer.from(chunk).toString("utf8");
        for (let i = buf.indexOf("\n\n"); i >= 0; i = buf.indexOf("\n\n")) {
          const frame = buf.slice(0, i);
          buf = buf.slice(i + 2);
          if (frame.startsWith("data: ")) events.push(JSON.parse(frame.slice(6)));
        }
      }
    } catch { /* stopped */ }
  })();
  return { events, stop: () => ctl.abort() };
}

// With a branch, rows no branch tags are hidden even before a gc removes them.
const symbolGone = (c, name, branch) => async () => (await c.call("lookup_symbol", { project_id: "demo", symbol_name: name, branch })).value?.length === 0;

describe("automatic garbage collection after quiet", () => {
  let w, c, feed;
  before(async () => {
    w = await makeWorld({ serverEnv: { SCRYBE_DAEMON_FS_DEBOUNCE_MS: "100", SCRYBE_DAEMON_COLD_MULTIPLIER: "1", SCRYBE_AUTO_GC_IDLE_MS: "1500", SCRYBE_AUTO_GC_RATIO: "2" } });
    await w.index("--full");
    c = w.client();
    await c.hello();
    await c.rpc("tools/list");
    await until(() => w.pidfile(), 10_000, "the pidfile");
    feed = await watchEvents(`http://127.0.0.1:${w.pidfile().port}`);
    await sleep(1500);
  });
  after(() => { feed?.stop(); return w.stop(); });
  const seen = (name, pick = () => true) => () => feed.events.find((e) => e.event === name && pick(e));

  test("a quiet project with orphans gets a gc job, then a quiet one without is skipped", async () => {
    rmSync(join(w.repo, "src/widget.ts"));
    await until(symbolGone(c, "frobnicateWidget", w.main), 30_000, "the deletion to be noticed");
    const scheduled = await until(seen("auto-gc.scheduled", (e) => e.detail.trigger === "idle"), 30_000, "auto-gc.scheduled");
    assert.equal(scheduled.projectId, "demo");
    assert.equal(scheduled.level, "info");
    const done = await until(seen("auto-gc.completed"), 30_000, "auto-gc.completed");
    assert.equal(done.projectId, "demo");
    for (const f of ["orphans_deleted", "bytes_freed", "duration_ms"]) assert.equal(typeof done.detail[f], "number");
    assert.ok(done.detail.orphans_deleted > 0);
    const jobs = (await c.call("list_jobs")).value;
    assert.ok(JSON.stringify(jobs).includes('"gc"'), "the gc job is recorded");
    const skipped = await until(seen("auto-gc.skipped", (e) => e.detail.reason === "no-orphans"), 30_000, "auto-gc.skipped");
    assert.equal(skipped.detail.trigger, "idle");
    assert.equal(skipped.projectId, "demo");
  });
});

describe("automatic garbage collection by orphan share", () => {
  let w, c, feed;
  before(async () => {
    w = await makeWorld({ serverEnv: { SCRYBE_DAEMON_FS_DEBOUNCE_MS: "100", SCRYBE_DAEMON_COLD_MULTIPLIER: "1", SCRYBE_AUTO_GC_IDLE_MS: "3600000", SCRYBE_AUTO_GC_RATIO: "0.01" } });
    await w.index("--full");
    c = w.client();
    await c.hello();
    await c.rpc("tools/list");
    await until(() => w.pidfile(), 10_000, "the pidfile");
    feed = await watchEvents(`http://127.0.0.1:${w.pidfile().port}`);
    await sleep(1500);
  });
  after(() => { feed?.stop(); return w.stop(); });
  const scheduled = () => feed.events.filter((e) => e.event === "auto-gc.scheduled");

  test("an index run that leaves many orphans queues a gc, and the debounce holds back the next", async () => {
    rmSync(join(w.repo, "src/widget.ts"));
    await until(symbolGone(c, "frobnicateWidget", w.main), 30_000, "the deletion to be noticed");
    const first = await until(() => scheduled()[0], 30_000, "auto-gc.scheduled");
    assert.equal(first.detail.trigger, "ratio");
    await until(() => feed.events.find((e) => e.event === "auto-gc.completed"), 30_000, "auto-gc.completed");
    // One deletion can start two index runs (Windows reports some deletes twice), and both may schedule
    // before the first gc finishes, in either build. The debounce counts from a finished gc.
    const before = scheduled().length;
    rmSync(join(w.repo, "src/gadget.py"));
    await until(symbolGone(c, "calibrate_gadget", w.main), 30_000, "the second deletion to be noticed");
    await sleep(2500);
    assert.equal(scheduled().length, before, JSON.stringify(scheduled()));
  });
});

describe("automatic garbage collection switched off", () => {
  let w, c, feed;
  before(async () => {
    w = await makeWorld({ serverEnv: { SCRYBE_DAEMON_FS_DEBOUNCE_MS: "100", SCRYBE_DAEMON_COLD_MULTIPLIER: "1", SCRYBE_AUTO_GC: "0", SCRYBE_AUTO_GC_IDLE_MS: "500", SCRYBE_AUTO_GC_RATIO: "0.01" } });
    await w.index("--full");
    c = w.client();
    await c.hello();
    await c.rpc("tools/list");
    await until(() => w.pidfile(), 10_000, "the pidfile");
    feed = await watchEvents(`http://127.0.0.1:${w.pidfile().port}`);
    await sleep(1500);
  });
  after(() => { feed?.stop(); return w.stop(); });

  test("SCRYBE_AUTO_GC=0 queues nothing", async () => {
    rmSync(join(w.repo, "src/widget.ts"));
    await until(symbolGone(c, "frobnicateWidget", w.main), 30_000, "the deletion to be noticed");
    await sleep(3000);
    assert.deepEqual(feed.events.filter((e) => e.event.startsWith("auto-gc.")), []);
  });
});

describe("the vector index after quiet", () => {
  let w, c, feed;
  const ids = async () => (await c.call("search_code", { project_id: "demo", query: "widget", top_k: 5 })).value.map((h) => h.chunk_id).sort();
  const completed = () => feed.events.filter((e) => e.event === "vector-index.completed");
  const hasVectorIndex = () => {
    const dir = join(w.data, "lancedb");
    return readdirSync(dir).filter((t) => t.endsWith(".lance")).some((t) => {
      const indices = join(dir, t, "_indices");
      return existsSync(indices) && readdirSync(indices).some((u) => readdirSync(join(indices, u)).some((f) => f === "auxiliary.idx"));
    });
  };
  before(async () => {
    w = await makeWorld({ serverEnv: { SCRYBE_DAEMON_FS_DEBOUNCE_MS: "100", SCRYBE_DAEMON_COLD_MULTIPLIER: "1", SCRYBE_VECTOR_INDEX_MIN_ROWS: "1", SCRYBE_VECTOR_INDEX_REBUILD_ROWS: "1", SCRYBE_VECTOR_INDEX_BACKFILL_IDLE_MS: "4000" } });
    await w.index("--full");
    c = w.client();
    await c.hello();
    await c.rpc("tools/list");
    await until(() => w.pidfile(), 10_000, "the pidfile");
    feed = await watchEvents(`http://127.0.0.1:${w.pidfile().port}`);
  });
  after(() => { feed?.stop(); return w.stop(); });

  test("a quiet project gets its index built, then rebuilt after growth, and searches answer the same", async () => {
    const before = await ids();
    assert.ok(before.length > 0);
    assert.equal(hasVectorIndex(), false);
    const built = await until(() => completed()[0], 30_000, "vector-index.completed");
    assert.equal(built.level, "info");
    assert.equal(typeof built.detail.tableName, "string");
    assert.equal(typeof built.detail.durationMs, "number");
    assert.equal(built.detail.forced, false);
    assert.ok(hasVectorIndex(), "the index files exist");
    assert.deepEqual(await ids(), before);
    const found = (await c.call("search_code", { project_id: "demo", query: "frobnicateWidget", top_k: 5 })).value;
    assert.ok(found.some((h) => h.symbol_name === "frobnicateWidget"));
    writeFileSync(join(w.repo, "src/saved_later.ts"), "export function savedWhileRunning() { return 7; }\n");
    await until(async () => (await c.call("lookup_symbol", { project_id: "demo", symbol_name: "savedWhileRunning" })).value?.length > 0, 30_000, "the saved file to be indexed");
    const rebuilt = await until(() => completed().find((e) => e.detail.forced), 30_000, "the forced rebuild");
    assert.equal(rebuilt.detail.tableName, built.detail.tableName);
    assert.ok((await ids()).length > 0);
  });
});

describe("the startup sweep of leaked ephemeral labels", () => {
  let w, c, feed;
  const label = "_ephemeral/review-1";
  const hashFile = () => join(w.data, "hashes", "demo__primary___ephemeral__review-1.json");
  before(async () => {
    w = await makeWorld({});
    await w.index("--full");
    // Pretend a crashed review left its label behind, holding the only tags of one file's rows.
    const db = new DatabaseSync(join(w.data, "branch-tags.db"));
    const moved = db.prepare("UPDATE branch_tags SET branch=? WHERE file_path LIKE '%gadget.py'").run(label);
    assert.ok(moved.changes > 0, "the fixture has rows to leak");
    db.prepare("INSERT INTO branch_state (project_id, source_id, branch, last_indexed_sha, last_indexed_at) VALUES ('demo','primary',?,'abc',0)").run(label);
    db.close();
    writeFileSync(hashFile(), "{}");
    c = w.client();
    await c.hello();
    await c.rpc("tools/list");
    await until(() => w.pidfile(), 10_000, "the pidfile");
    feed = await watchEvents(`http://127.0.0.1:${w.pidfile().port}`);
  });
  after(() => { feed?.stop(); return w.stop(); });

  test("the label, its state and its orphaned rows are reclaimed once, and announced", async () => {
    const swept = await until(() => feed.events.find((e) => e.event === "ephemeral.swept"), 30_000, "ephemeral.swept");
    assert.equal(swept.level, "info");
    assert.equal(swept.detail.count, 1);
    const [entry] = swept.detail.entries;
    assert.equal(entry.projectId, "demo");
    assert.equal(entry.sourceId, "primary");
    assert.equal(entry.label, label);
    assert.ok(entry.orphansDeleted > 0);
    assert.equal(typeof entry.bytesFreed, "number");
    const db = new DatabaseSync(join(w.data, "branch-tags.db"), { readOnly: true });
    assert.equal(db.prepare("SELECT COUNT(*) AS n FROM branch_tags WHERE branch LIKE '%ephemeral%'").get().n, 0);
    assert.equal(db.prepare("SELECT COUNT(*) AS n FROM branch_state WHERE branch LIKE '%ephemeral%'").get().n, 0);
    db.close();
    assert.throws(() => readFileSync(hashFile()), /ENOENT/);
    const found = (await c.call("lookup_symbol", { project_id: "demo", symbol_name: "frobnicateWidget" })).value;
    assert.ok(found.length > 0, "the main branch is untouched");
  });
});

// Its own world with the fetch poller off: every fetch rewrites FETCH_HEAD, and both builds start a job for that.
describe("ignored files", () => {
  let w, c;
  before(async () => {
    w = await makeWorld({ serverEnv: { SCRYBE_DAEMON_FS_DEBOUNCE_MS: "100", SCRYBE_DAEMON_COLD_MULTIPLIER: "1" } });
    await w.index("--full");
    c = w.client();
    await c.hello();
    await sleep(1500);
  });
  after(() => w.stop());

  test("an ignored file doesn't start a job, and a real one does", async (t) => {
    const names = await c.toolNames();
    if (!names.includes("gc")) return t.skip("not ported");
    // list_jobs only shows jobs started by hand, so count the server's own job events instead.
    const started = () => { try { return readFileSync(join(w.data, "daemon-log.jsonl"), "utf8").split("\n").filter((l) => l.includes('"job.started"')).length; } catch { return 0; } };
    const before = started();
    writeFileSync(join(w.repo, "notes/ignored_too.ts"), "export function neverIndexed() { return 7; }\n");
    await sleep(2500);
    assert.equal(started(), before);
    writeFileSync(join(w.repo, "src/not_ignored.ts"), "export function indexedAfterAll() { return 7; }\n");
    await until(async () => started() > before, 15_000, "a job for the real file");
  });
});

describe("the server's own lifetime", () => {
  let w;
  before(async () => { w = await makeWorld(); await w.index("--full"); });
  after(() => w.stop());
  const running = (pid) => { try { process.kill(pid, 0); return true; } catch { return false; } };

  test("with no client it leaves by itself, and an idle client keeps it", async () => {
    const short = { SCRYBE_DAEMON_KEEP_ALIVE: "", SCRYBE_DAEMON_NO_CLIENT_TIMEOUT_MS: "3000", SCRYBE_DAEMON_IDLE_GRACE_MS: "2000", SCRYBE_DAEMON_HEARTBEAT_STALE_MS: "4000", SCRYBE_DAEMON_HEARTBEAT_MS: "1000" };
    const c = w.client({ extraEnv: short });
    await c.hello();
    await c.rpc("tools/list");
    const pid = w.pidfile().pid;
    await sleep(6000);
    assert.ok(running(pid), "an idle client should keep it up past the 3 s limit");
    c.close();
    await until(() => !running(pid), 20_000, "the server to leave after its client");
    assert.equal(w.pidfile(), null, "a clean exit removes the pidfile");
  });

  test("SIGTERM exits cleanly and removes the pidfile", { skip: process.platform === "win32" ? "no SIGTERM on Windows" : false }, async () => {
    const c = w.client();
    await c.hello();
    await c.rpc("tools/list");
    const pid = w.pidfile().pid;
    process.kill(pid, "SIGTERM");
    await until(() => !running(pid), 20_000, "the server to exit");
    assert.equal(w.pidfile(), null);
  });

  test("a second server on the same data dir exits at once and leaves the first alone", async () => {
    const c = w.client();
    await c.hello();
    await c.rpc("tools/list");
    const first = w.pidfile();
    const second = spawn(SERVER[0], SERVER.slice(1), { env: w.env, stdio: "ignore", windowsHide: true });
    await new Promise((resolve) => second.on("exit", resolve));
    assert.equal(w.pidfile().pid, first.pid);
    assert.ok(await w.health());
  });
});

describe("the command line", () => {
  let w;
  before(async () => { w = await makeWorld(); await w.index("--full"); });
  after(() => w.stop());

  test("searches code as text", async () => {
    const r = await w.cli("search", "code", "-P", "demo", "frobnicateWidget");
    assert.equal(r.status, 0, r.stderr);
    assert.match(r.stdout, /src\/widget\.ts/);
  });

  test("search code and search knowledge ignore --top-k after the subcommand", async () => {
    const plain = await w.cli("search", "code", "-P", "demo", "widget");
    const one = await w.cli("search", "code", "-P", "demo", "--top-k", "1", "widget");
    assert.equal(plain.status, 0, plain.stderr);
    assert.ok(plain.stdout.trim().split("\n").filter((l) => l.startsWith("[")).length > 1, plain.stdout);
    assert.equal(one.stdout, plain.stdout);
    const k = await w.cli("search", "knowledge", "-P", "demo", "--top-k", "1", "widget");
    assert.equal(k.stderr, (await w.cli("search", "knowledge", "-P", "demo", "widget")).stderr);
  });

  test("a search on an unknown project exits 1 with the message and nothing else", async () => {
    for (const kind of ["code", "knowledge"]) {
      const r = await w.cli("search", kind, "-P", "nope", "x");
      assert.deepEqual([r.status, r.stdout, r.stderr], [1, "", "[scrybe] Project 'nope' not found\n"], kind);
    }
  });

  test("the command line lists projects as text", gap("the command line lists projects as text"), async () => {
    const r = await w.cli("project", "list");
    assert.equal(r.status, 0, r.stderr);
    assert.match(r.stdout, /demo/);
    assert.match(r.stdout, /primary/);
  });
});

describe("the project, source and job commands", () => {
  let w;
  // The first command on a fresh data dir may print a one-time notice, so it runs before anything is compared.
  before(async () => { w = await makeWorld(); await w.cli("projects"); });
  after(() => w.stop());

  const readProjects = () => JSON.parse(readFileSync(join(w.data, "projects.json"), "utf8"));
  const failure = (r, message) => {
    assert.equal(r.status, 1, r.stdout + r.stderr);
    assert.equal(r.stdout, "");
    assert.equal(r.stderr, `[scrybe] ${message}\n`);
  };

  test("projects are listed as text by project list, its alias and the shorthand", async () => {
    const expected = `\ndemo — A demo\n  ○ ${"primary".padEnd(20)} ${"code".padEnd(10)} never\n`;
    for (const args of [["project", "list"], ["project", "ls"], ["projects"]]) {
      const r = await w.cli(...args);
      assert.equal(r.status, 0, r.stderr);
      assert.equal(r.stdout, expected, args.join(" "));
      assert.equal(r.stderr, "");
    }
  });

  test("a project is added, described, updated and removed", async () => {
    let r = await w.cli("project", "add", "--id", "extra", "--desc", "Second");
    assert.deepEqual([r.status, r.stdout, r.stderr], [0, "Added project 'extra'\n", ""]);
    assert.match((await w.cli("projects")).stdout, /\nextra — Second\n {2}\(no sources\)/);
    failure(await w.cli("project", "add", "--id", "extra"), "Project 'extra' already exists");

    r = await w.cli("project", "update", "extra", "--desc", "Changed");
    assert.deepEqual([r.status, r.stdout], [0, "Updated project 'extra'\n"]);
    r = await w.cli("project", "update", "--id", "extra", "--desc", "Changed again");
    assert.deepEqual([r.status, r.stdout], [0, "Updated project 'extra'\n"]);
    assert.equal(readProjects().find((p) => p.id === "extra").description, "Changed again");
    failure(await w.cli("project", "update", "--desc", "x"), "project id required (positional or --id)");
    failure(await w.cli("project", "update", "nope", "--desc", "x"), "Project 'nope' not found");

    r = await w.cli("project", "remove", "extra");
    assert.deepEqual([r.status, r.stdout, r.stderr], [0, "Removed project 'extra'\n", ""]);
    assert.ok(!readProjects().some((p) => p.id === "extra"));
    for (const verb of ["rm", "delete"]) {
      await w.cli("project", "add", "--id", "tmp");
      r = await w.cli("project", verb, "--id", "tmp");
      assert.deepEqual([r.status, r.stdout], [0, "Removed project 'tmp'\n"], verb);
    }
    failure(await w.cli("project", "remove", "nope"), "Project 'nope' not found");
    failure(await w.cli("project", "remove"), "project id required (positional or --id)");
  });

  test("a missing required option is named and exits 1", async () => {
    const r = await w.cli("project", "add");
    assert.deepEqual([r.status, r.stdout, r.stderr], [1, "", "error: required option '--id <id>' not specified\n"]);
    const s = await w.cli("source", "add", "-P", "demo");
    assert.equal(s.stderr, "error: required option '-S, --source-id <id>' not specified\n");
    assert.equal(s.status, 1);
  });

  test("sources are listed by source list, its alias and the shorthand", async () => {
    const line = "demo  [primary] type=code  never indexed  not searchable\n";
    for (const args of [["source", "list"], ["source", "ls"], ["sources"], ["sources", "-P", "demo"], ["source", "list", "-P", "demo"]]) {
      const r = await w.cli(...args);
      assert.deepEqual([r.status, r.stdout, r.stderr], [0, line, ""], args.join(" "));
    }
    for (const args of [["source", "list", "-P", "nope"], ["sources", "-P", "nope"]]) {
      const r = await w.cli(...args);
      assert.deepEqual([r.status, r.stdout], [0, "No sources found.\n"], args.join(" "));
    }
  });

  test("a code source is added, indexed, updated and removed", async () => {
    let r = await w.cli("source", "add", "-P", "demo", "-S", "extra", "--type", "code", "--root", w.repo, "--languages", "ts,py");
    assert.equal(r.status, 0, r.stderr);
    assert.match(r.stdout, /^Added source 'extra' to project 'demo' — reindex job: [0-9a-f]{8}\n$/);
    assert.deepEqual(readProjects()[0].sources[1].source_config, { type: "code", root_path: w.repo, languages: ["ts", "py"] });
    r = await w.cli("source", "list", "-P", "demo");
    assert.match(r.stdout, /^demo {2}\[extra\] type=code {2}indexed: \d{4}-\d\d-\d\dT[\d:.]+Z {2}searchable$/m);

    failure(await w.cli("source", "add", "-P", "demo", "-S", "extra", "--type", "code", "--root", w.repo), "Source 'extra' already exists in project 'demo'");
    failure(await w.cli("source", "add", "-P", "nope", "-S", "x", "--type", "code", "--root", w.repo), "Project 'nope' not found");

    r = await w.cli("source", "update", "-P", "demo", "-S", "extra", "--languages", "go, rs");
    assert.deepEqual([r.status, r.stdout, r.stderr], [0, "Updated source 'extra' in project 'demo'\n", ""]);
    assert.deepEqual(readProjects()[0].sources[1].source_config.languages, ["go", "rs"]);
    r = await w.cli("source", "update", "-P", "demo", "-S", "extra", "--root", w.repo);
    assert.equal(r.stdout, "Updated source 'extra' in project 'demo'\n");
    r = await w.cli("source", "update", "-P", "demo", "-S", "extra");
    assert.deepEqual([r.status, r.stdout], [0, "Nothing to update — specify at least one option to change.\n"]);
    failure(await w.cli("source", "update", "-P", "demo", "-S", "nope", "--root", "x"), "Source 'nope' not found in project 'demo'");

    r = await w.cli("source", "remove", "-P", "demo", "-S", "extra");
    assert.deepEqual([r.status, r.stdout, r.stderr], [0, "Removed source 'extra' from project 'demo'\n", ""]);
    assert.equal(readProjects()[0].sources.length, 1);
    failure(await w.cli("source", "remove", "-P", "demo", "-S", "extra"), "Source 'extra' not found in project 'demo'");
    failure(await w.cli("source", "remove", "-P", "nope", "-S", "extra"), "Project 'nope' not found");
    for (const verb of ["rm", "delete"]) {
      await w.cli("source", "add", "-P", "demo", "-S", "tmp", "--type", "code", "--root", w.repo);
      r = await w.cli("source", verb, "-P", "demo", "-S", "tmp");
      assert.deepEqual([r.status, r.stdout], [0, "Removed source 'tmp' from project 'demo'\n"], verb);
    }
  });

  test("jobs are listed by job list and the shorthand", async () => {
    const line = /^\[[0-9a-f]{8}\] demo \| reindex \| done \| \d+\.\ds$/;
    const listed = await w.cli("job", "list");
    assert.equal(listed.status, 0, listed.stderr);
    const lines = listed.stdout.trimEnd().split("\n");
    assert.ok(lines.length >= 3, listed.stdout);
    for (const l of lines) assert.match(l, line);
    const short = await w.cli("jobs");
    assert.equal(short.stdout.trimEnd().split("\n").map((l) => l.slice(0, 11)).join(), lines.map((l) => l.slice(0, 11)).join());
    for (const args of [["job", "list", "--running"], ["jobs", "--running"]]) {
      const r = await w.cli(...args);
      assert.deepEqual([r.status, r.stdout, r.stderr], [0, "No jobs found.\n", ""], args.join(" "));
    }
  });
});

describe("source add with a server running", () => {
  let w;
  before(async () => { w = await makeWorld(); await w.cli("projects"); });
  after(() => w.stop());

  test("the server takes the job, and its job list shows it", async () => {
    const c = w.client();
    await c.hello();
    await c.toolNames();
    assert.ok(await w.health());
    const r = await w.cliLive("source", "add", "-P", "demo", "-S", "extra", "--type", "code", "--root", w.repo);
    assert.equal(r.status, 0, r.stderr);
    const id = r.stdout.match(/^Added source 'extra' to project 'demo' — reindex job: ([0-9a-f]{8})\n$/)?.[1];
    assert.ok(id, r.stdout);
    const seen = await until(async () => (await c.call("list_jobs", {})).value?.jobs.find((j) => j.job_id === id), 30_000, "the job in the server's list");
    assert.equal(seen.project_id, "demo");
    await until(async () => (await c.call("reindex_status", { job_id: id })).value?.status === "done", 60_000, "the job to finish");
  });
});

describe("the branch commands", () => {
  let w;
  before(async () => { w = await makeWorld({ withOrigin: true }); await w.index("--full"); });
  after(() => w.stop());

  const json = (r) => {
    assert.equal(r.status, 0, r.stderr);
    return JSON.parse(r.stdout);
  };
  const failure = (r, message) => {
    assert.equal(r.status, 1, r.stdout + r.stderr);
    assert.equal(r.stdout, "");
    assert.equal(r.stderr, `[scrybe] ${message}\n`);
  };
  const pinned = async () => json(await w.cli("branch", "list", "-P", "demo", "--pinned"))[0].branches;

  test("indexed branches are listed as JSON by branch list, its alias and the shorthand", async () => {
    const expected = [{ source_id: "primary", branches: [w.main] }];
    for (const args of [["branch", "list", "-P", "demo"], ["branch", "ls", "-P", "demo"], ["branches", "-P", "demo"], ["branch", "list", "-P", "demo", "-S", "primary"], ["branches", "-P", "demo", "-S", "primary"]]) {
      const r = await w.cli(...args);
      assert.deepEqual(json(r), expected, args.join(" "));
      assert.equal(r.stdout, JSON.stringify(expected, null, 2) + "\n");
    }
    assert.deepEqual(json(await w.cli("branch", "list", "-P", "demo", "-S", "nope")), []);
    failure(await w.cli("branch", "list", "-P", "nope"), "Project 'nope' not found");
    failure(await w.cli("branches", "-P", "nope"), "Project 'nope' not found");
    const r = await w.cli("branch", "list");
    assert.deepEqual([r.status, r.stdout, r.stderr], [1, "", "error: required option '-P, --project-id <id>' not specified\n"]);
  });

  test("branches are pinned and unpinned", async () => {
    assert.deepEqual(await pinned(), []);
    let r = await w.cli("branch", "pin", "-P", "demo", "side");
    const pinnedSide = json(r);
    assert.deepEqual({ ...pinnedSide, ignore_warnings: undefined }, { branches: ["side"], added: ["side"], warnings: [], ignore_warnings: undefined });
    assert.equal(pinnedSide.ignore_warnings.length, 1);
    assert.match(pinnedSide.ignore_warnings[0], /^warning: branch 'side' has no \.scrybeignore/);
    assert.equal(r.stderr, `\x1b[33m${pinnedSide.ignore_warnings[0]}\x1b[0m\n`);

    r = await w.cli("branch", "p", "-P", "demo", "-S", "primary", "side", "other");
    assert.deepEqual({ ...json(r), ignore_warnings: undefined }, { branches: ["side", "other"], added: ["other"], warnings: [], ignore_warnings: undefined });
    assert.deepEqual(await pinned(), ["side", "other"]);
    assert.deepEqual(json(await w.cli("branches", "-P", "demo", "--pinned")), [{ source_id: "primary", branches: ["side", "other"] }]);
    assert.deepEqual(json(await w.cli("branch", "ls", "-P", "demo", "-p", "-S", "primary")), [{ source_id: "primary", branches: ["side", "other"] }]);
    assert.deepEqual(json(await w.cli("branch", "list", "-P", "demo", "-p", "-S", "nope")), []);

    assert.deepEqual(json(await w.cli("branch", "unpin", "-P", "demo", "other", "never-pinned")), { branches: ["side"], removed: ["other"] });
    assert.deepEqual(json(await w.cli("branch", "u", "-P", "demo", "-S", "primary", "side")), { branches: [], removed: ["side"] });
    assert.deepEqual(await pinned(), []);
  });

  test("unpin --all asks first, and --yes skips the question", async () => {
    assert.deepEqual(await pinned(), []);
    await w.cli("branch", "pin", "-P", "demo", "a", "b");
    let r = await w.cliInput("n\n", "branch", "unpin", "-P", "demo", "--all");
    assert.deepEqual([r.status, r.stdout, r.stderr], [0, "Clear all pinned branches for demo/primary? [y/N] Aborted.\n", ""]);
    assert.deepEqual(await pinned(), ["a", "b"]);
    r = await w.cliInput("y\n", "branch", "unpin", "-P", "demo", "--all");
    assert.equal(r.status, 0, r.stderr);
    assert.ok(r.stdout.startsWith("Clear all pinned branches for demo/primary? [y/N] "));
    assert.deepEqual(JSON.parse(r.stdout.slice("Clear all pinned branches for demo/primary? [y/N] ".length)), { branches: [], removed: ["a", "b"] });
    await w.cli("branch", "pin", "-P", "demo", "c");
    r = await w.cli("branch", "unpin", "-P", "demo", "--all", "--yes");
    assert.deepEqual(JSON.parse(r.stdout), { branches: [], removed: ["c"] });
    assert.equal(r.stderr, "");
  });

  test("pin and unpin errors name the problem", async () => {
    failure(await w.cli("branch", "pin", "-P", "nope", "x"), "Project 'nope' not found");
    failure(await w.cli("branch", "pin", "-P", "demo", "-S", "nope", "x"), "Source 'nope' not found in project 'demo'");
    failure(await w.cli("branch", "unpin", "-P", "nope", "x"), "Project 'nope' not found");
    failure(await w.cli("branch", "unpin", "-P", "nope", "--all", "--yes"), "Project 'nope' not found");
    const r = await w.cli("branch", "unpin", "-P", "demo");
    assert.deepEqual([r.status, r.stdout, r.stderr], [1, "", "Specify branch names to unpin, or use --all to clear all.\n"]);
  });
});

describe("the ephemeral branch commands", () => {
  let w;
  before(async () => { w = await makeWorld({ withOrigin: true }); await w.index("--full"); });
  after(() => w.stop());

  const failure = (r, message) => {
    assert.equal(r.status, 1, r.stdout + r.stderr);
    assert.equal(r.stdout, "");
    assert.equal(r.stderr, `[scrybe] ${message}\n`);
  };
  const branches = async () => JSON.parse((await w.cli("branch", "list", "-P", "demo")).stdout)[0].branches;

  test("a label made through the server is dropped again", async () => {
    const c = w.client();
    await c.hello();
    assert.equal((await c.call("index_ephemeral", { project_id: "demo", branch: "side" })).value.label, "_ephemeral/mr-side");
    assert.equal((await c.call("index_ephemeral", { project_id: "demo", branch: "origin/side", label: "review-1" })).value.label, "_ephemeral/review-1");
    await w.killServer();
    assert.deepEqual((await branches()).sort(), [w.main, "_ephemeral/mr-side", "_ephemeral/review-1"].sort());

    let r = await w.cli("drop-ephemeral", "-P", "demo", "--label", "_ephemeral/mr-side");
    assert.equal(r.status, 0, r.stderr);
    const dropped = JSON.parse(r.stdout);
    assert.deepEqual(Object.keys(dropped), ["label", "dropped", "orphans_deleted", "bytes_freed"]);
    assert.equal(dropped.label, "_ephemeral/mr-side");
    assert.equal(dropped.dropped, true);
    assert.ok(Number.isInteger(dropped.orphans_deleted) && Number.isInteger(dropped.bytes_freed));
    assert.deepEqual((await branches()).sort(), [w.main, "_ephemeral/review-1"].sort());

    r = await w.cli("drop-ephemeral", "-P", "demo", "--label", "_ephemeral/mr-side", "-S", "primary");
    assert.equal(JSON.parse(r.stdout).dropped, false);
    r = await w.cli("drop-ephemeral", "-P", "demo", "--label", "_ephemeral/review-1");
    assert.equal(JSON.parse(r.stdout).dropped, true);
    assert.deepEqual(await branches(), [w.main]);
  });

  // Today's command line never hands index-ephemeral its options, so the project it looks up is "undefined".
  test("index-ephemeral names no project, as today's build does", async () => {
    failure(await w.cli("index-ephemeral", "-P", "demo", "--branch", "side"), "Project 'undefined' not found");
    failure(await w.cli("index-ephemeral", "-P", "nope", "--branch", "side", "--label", "x", "-S", "primary"), "Project 'undefined' not found");
    const r = await w.cli("index-ephemeral", "-P", "demo");
    assert.deepEqual([r.status, r.stdout, r.stderr], [1, "", "error: required option '--branch <name>' not specified\n"]);
  });

  test("drop-ephemeral errors name the problem", async () => {
    failure(await w.cli("drop-ephemeral", "-P", "nope", "--label", "_ephemeral/x"), "Project 'nope' not found");
    failure(await w.cli("drop-ephemeral", "-P", "demo", "--label", "dev"), "drop_ephemeral refuses to drop 'dev' — only labels under '_ephemeral/' can be dropped (safety: this verb must never remove a real branch like 'dev' or 'master').");
    const d = await w.cli("drop-ephemeral", "-P", "demo");
    assert.deepEqual([d.status, d.stdout, d.stderr], [1, "", "error: required option '--label <label>' not specified\n"]);
  });
});

describe("the gc command", () => {
  let w;
  // The first command after an index may print a one-time notice, so it runs before anything is compared.
  before(async () => { w = await makeWorld(); await w.index("--full"); await w.cli("projects"); });
  after(() => w.stop());

  const COMPACTING = /\n\nCompacting Lance tables\.\.\.\n(?:.*\n)*Done\. .*\.\n$/;

  test("a project that does not exist is named, without the usual prefix", async () => {
    const r = await w.cli("gc", "-P", "nope");
    assert.deepEqual([r.status, r.stdout, r.stderr], [1, "", "Project 'nope' not found\n"]);
  });

  test("with no server it finds nothing, then counts orphans, then deletes them", async () => {
    let r = await w.cli("gc", "--dry-run");
    assert.deepEqual([r.status, r.stdout, r.stderr], [0, "No orphan chunks found.\n", ""]);

    await w.index("--branch", "side");
    const db = new DatabaseSync(join(w.data, "branch-tags.db"));
    db.prepare("DELETE FROM branch_tags WHERE branch = ?").run("side");
    db.close();

    r = await w.cli("gc", "--dry-run");
    assert.equal(r.status, 0, r.stderr);
    const counted = r.stdout.match(/^ {2}demo\/primary: (\d+) orphan chunk\(s\)\n\nDry run: (\d+) orphan chunk\(s\) found \(not deleted\)\.\n$/);
    assert.ok(counted && Number(counted[1]) > 0 && counted[1] === counted[2], r.stdout);

    r = await w.cli("gc");
    assert.equal(r.status, 0, r.stderr);
    assert.match(r.stdout, new RegExp(`^ {2}demo/primary: ${counted[1]} orphan chunk\\(s\\)\\n\\nGC complete: ${counted[1]} orphan chunk\\(s\\) deleted\\.${COMPACTING.source}`));

    r = await w.cli("gc");
    assert.equal(r.status, 0, r.stderr);
    assert.match(r.stdout, new RegExp(`^No orphan chunks found\\.${COMPACTING.source}`));
  });

  test("a project with no sources is reported on a dry run, and only without -P", async () => {
    await w.cli("project", "add", "--id", "hollow");
    let r = await w.cli("gc", "--dry-run");
    assert.deepEqual([r.status, r.stdout], [0, "No orphan chunks found.\n\nDry run: 1 empty project(s) would be pruned: hollow\n"]);
    r = await w.cli("gc", "-P", "demo", "--dry-run");
    assert.deepEqual([r.status, r.stdout], [0, "No orphan chunks found.\n"]);
    r = await w.cli("gc");
    assert.equal(r.status, 0, r.stderr);
    assert.ok(!r.stdout.includes("Pruned"), "nothing is pruned without a person at the terminal");
    assert.ok(readFileSync(join(w.data, "projects.json"), "utf8").includes('"hollow"'));
  });

  test("with a server running it queues a job there and returns", async () => {
    const live = await makeWorld();
    try {
      await live.index("--full");
      const c = live.client();
      await c.hello();
      await c.toolNames();
      const r = await live.cliLive("gc");
      assert.equal(r.status, 0, r.stderr);
      const m = r.stdout.match(/^Submitted gc job\(s\) for 1 project\(s\) via daemon queue:\n {2}demo: job ([0-9a-f]{8}) \((queued|running)\)\nRun 'scrybe job list' to monitor progress\.\n$/);
      assert.ok(m, r.stdout);
      const done = await until(async () => {
        const s = (await c.call("reindex_status", { job_id: m[1] })).value;
        return ["done", "failed"].includes(s?.status) && s;
      }, 30_000, "the gc job");
      assert.equal(done.status, "done");
      assert.equal(done.type, "gc");
    } finally {
      await live.stop();
    }
  });
});

describe("the ignore commands", () => {
  let w;
  before(async () => { w = await makeWorld(); await w.cli("projects"); });
  after(() => w.stop());

  const file = () => join(w.data, "ignores", "demo", "primary.gitignore");
  const failure = (r, message) => {
    assert.equal(r.status, 1, r.stdout + r.stderr);
    assert.equal(r.stdout, "");
    assert.equal(r.stderr, `[scrybe] ${message}\n`);
  };

  test("nothing is listed until rules exist", async () => {
    let r = await w.cli("ignore", "list");
    assert.deepEqual([r.status, r.stdout, r.stderr], [0, "No private ignore files.\n", ""]);
    r = await w.cli("ignore", "list", "--json");
    assert.deepEqual([r.status, r.stdout], [0, "[]\n"]);
    r = await w.cli("ignore", "get", "-P", "demo", "-S", "primary");
    assert.deepEqual([r.status, r.stdout], [0, `# No private ignore file for demo/primary\n# Expected at: ${file()}\n`]);
    r = await w.cli("ignore", "get", "-P", "demo", "-S", "primary", "--json");
    assert.deepEqual(JSON.parse(r.stdout), { project_id: "demo", source_id: "primary", content: null, path: file(), rule_count: 0 });
  });

  test("rules are listed and printed", async () => {
    mkdirSync(join(w.data, "ignores", "demo"), { recursive: true });
    writeFileSync(file(), "# mine\nvendor/\n*.log\n");
    let r = await w.cli("ignore", "list");
    assert.equal(r.status, 0, r.stderr);
    assert.match(r.stdout, new RegExp(`^demo/primary — 2 rule\\(s\\) \\(modified \\d{4}-\\d\\d-\\d\\dT[\\d:.]+Z\\)\\n  ${file().replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\n$`));
    r = await w.cli("ignore", "list", "-P", "demo", "--json");
    const [entry] = JSON.parse(r.stdout);
    assert.deepEqual(Object.keys(entry), ["project_id", "source_id", "path", "rule_count", "mtime"]);
    assert.deepEqual([entry.project_id, entry.source_id, entry.path, entry.rule_count], ["demo", "primary", file(), 2]);
    r = await w.cli("ignore", "get", "-P", "demo", "-S", "primary");
    assert.deepEqual([r.status, r.stdout], [0, "# mine\nvendor/\n*.log\n"]);
    writeFileSync(file(), "vendor/");
    assert.equal((await w.cli("ignore", "get", "-P", "demo", "-S", "primary")).stdout, "vendor/\n");
    r = await w.cli("ignore", "get", "-P", "demo", "-S", "primary", "--json");
    assert.deepEqual(JSON.parse(r.stdout), { project_id: "demo", source_id: "primary", content: "vendor/", path: file(), rule_count: 1 });
  });

  test("errors name the problem", async () => {
    failure(await w.cli("ignore", "list", "-P", "nope"), "Project 'nope' not found");
    failure(await w.cli("ignore", "get", "-P", "nope", "-S", "primary"), "Project 'nope' not found");
    failure(await w.cli("ignore", "get", "-P", "demo", "-S", "nope"), "Source 'nope' not found in project 'demo'");
    const r = await w.cli("ignore", "get", "-P", "demo");
    assert.deepEqual([r.status, r.stdout, r.stderr], [1, "", "error: required option '-S, --source-id <id>' not specified\n"]);
  });

  test("the interactive editor is not in this build", { skip: BUILD === "rust" ? false : "today's build opens a wizard" }, async () => {
    for (const args of [["ignore"], ["ignore", "edit"]]) {
      const r = await w.cli(...args);
      assert.equal(r.status, 1);
      assert.equal(r.stdout, "");
      assert.match(r.stderr, /^\[scrybe\] .*not available in this build yet/);
    }
  });
});

describe("the daemon commands", () => {
  let w;
  before(async () => { w = await makeWorld(); await w.cli("projects"); });
  after(() => w.stop());

  test("with no server, stop says so and refresh fails", async () => {
    let r = await w.cli("daemon", "stop");
    assert.deepEqual([r.status, r.stdout, r.stderr], [0, "Daemon is not running.\n", ""]);
    r = await w.cli("daemon", "refresh");
    assert.deepEqual([r.status, r.stdout, r.stderr], [1, "", "Daemon is not running (no pidfile or port not yet bound).\n"]);
    r = await w.cliWith({ SCRYBE_NO_DEPRECATION_WARNING: "1" }, "daemon", "kick");
    assert.deepEqual([r.status, r.stdout, r.stderr], [1, "", "Daemon is not running (no pidfile or port not yet bound).\n"]);
  });

  test("up starts nothing when starting is switched off, and says so only when asked", async () => {
    let r = await w.cli("daemon", "up");
    assert.deepEqual([r.status, r.stdout, r.stderr], [0, "", ""]);
    r = await w.cli("daemon", "ensure-running", "--verbose");
    assert.deepEqual([r.status, r.stdout, r.stderr], [0, "Skipping daemon start (opted-out).\n", ""]);
    assert.equal(w.pidfile(), null);
  });

  test("up starts a server, refresh gives it a job, and stop ends it", async (t) => {
    let r = await w.cliLive("daemon", "up", "--verbose");
    if (r.stdout.startsWith("Skipping daemon start (container)")) return t.skip("this host counts as a container");
    assert.deepEqual([r.status, r.stdout, r.stderr], [0, "Daemon is running.\n", ""]);
    const first = w.pidfile();
    assert.ok(await w.health());

    r = await w.cliLive("daemon", "up");
    assert.deepEqual([r.status, r.stdout, r.stderr], [0, "", ""]);
    assert.equal(w.pidfile().pid, first.pid);

    r = await w.cliLive("daemon", "refresh", "-P", "demo");
    assert.equal(r.status, 0, r.stderr);
    const queued = JSON.parse(r.stdout);
    assert.equal(queued.jobs[0].projectId, "demo");
    assert.match(queued.jobs[0].jobId, /^[0-9a-f]{8}$/);
    await until(async () => (await w.cli("jobs", "--running")).stdout === "No jobs found.\n", 60_000, "the refresh job");

    r = await w.cliLive("daemon", "kick", "--project-id", "demo", "--source-id", "primary");
    assert.deepEqual([r.status, r.stderr], [0, "[deprecated] 'daemon kick' renamed to 'daemon refresh'; will be removed in v1.0\n"]);
    assert.match(JSON.parse(r.stdout).jobs[0].jobId, /^[0-9a-f]{8}$/);
    r = await w.cliLive("daemon", "kick", "-P", "demo");
    assert.deepEqual([r.status, r.stdout, r.stderr], [1, "", "error: unknown option '-P'\n"]);
    await until(async () => (await w.cli("jobs", "--running")).stdout === "No jobs found.\n", 60_000, "the kicked job");

    r = await w.cliLive("daemon", "stop");
    assert.deepEqual([r.status, r.stdout, r.stderr], [0, "Daemon stopped.\n", ""]);
    assert.equal(w.pidfile(), null);
    r = await w.cliLive("daemon", "stop");
    assert.deepEqual([r.status, r.stdout], [0, "Daemon is not running.\n"]);
  });
});

describe("jobs an earlier server left behind", () => {
  let w;
  before(async () => { w = await makeWorld(); await w.cli("projects"); await w.index(); });
  after(() => w.stop());

  const insert = (rows) => {
    const db = new DatabaseSync(join(w.data, "branch-tags.db"));
    const st = db.prepare("INSERT INTO jobs (job_id, project_id, mode, status, queued_at, origin) VALUES (?,?,'incremental',?,?,'daemon')");
    for (const r of rows) st.run(...r);
    db.close();
  };
  const job = (id) => {
    const db = new DatabaseSync(join(w.data, "branch-tags.db"), { readOnly: true });
    try { return db.prepare("SELECT status, error_message, finished_at FROM jobs WHERE job_id=?").get(id); } finally { db.close(); }
  };
  const pair = (id) => { const j = job(id); return [j.status, j.error_message]; };

  test("are closed at start, the gone project's as cancelled, and later ones are left alone", async () => {
    const now = Date.now();
    insert([["o-run", "demo", "running", now - 3_600_000], ["o-queued", "demo", "queued", now - 7_200_000], ["o-all", "*", "running", now - 10_000_000], ["o-gone", "gone", "queued", now - 9_000_000], ["o-later", "demo", "queued", now + 3_600_000]]);
    const r = await w.cliBare({}, "daemon", "up", "--verbose");
    if (r.stdout.startsWith("Skipping daemon start (container)")) return;
    assert.deepEqual([r.status, r.stdout], [0, "Daemon is running.\n"], r.stderr);
    for (const id of ["o-run", "o-queued", "o-all"]) assert.deepEqual(pair(id), ["interrupted", "interrupted by daemon restart"], id);
    assert.deepEqual(pair("o-gone"), ["cancelled", "project no longer exists (zombie cleanup)"]);
    assert.ok(job("o-run").finished_at >= now);
    assert.deepEqual(pair("o-later"), ["queued", null]);
    const events = w.logged("jobs.reconciled");
    assert.equal(events.length, 1);
    const { interrupted, cancelled, sampleJobIds, cutoffMs } = events[0].detail;
    assert.deepEqual({ interrupted, cancelled, sampleJobIds }, { interrupted: 3, cancelled: 1, sampleJobIds: ["o-all", "o-gone", "o-queued", "o-run"] });
    const [start] = w.logged("daemon.start");
    assert.equal(start.pid, w.pidfile().pid);
    assert.ok(cutoffMs >= now && cutoffMs <= Date.parse(start.ts), "the cutoff is when the lock was taken");
    await w.killServer();
  });

  test("count as interrupted, not cancelled, when the project list can't be read", async () => {
    insert([["u-run", "demo", "running", Date.now() - 1000], ["u-gone", "gone", "running", Date.now() - 1000]]);
    const file = join(w.data, "projects.json");
    const saved = readFileSync(file, "utf8");
    writeFileSync(file, "{ not json");
    const r = await w.cliBare({}, "daemon", "up");
    writeFileSync(file, saved);
    if (!w.pidfile()) return;
    assert.equal(r.status, 0, r.stderr);
    for (const id of ["u-run", "u-gone"]) assert.deepEqual(pair(id), ["interrupted", "interrupted by daemon restart"], id);
    await w.killServer();
  });
});

describe("the locks on a data dir", () => {
  let w;
  before(async () => { w = await makeWorld(); await w.cli("projects"); });
  afterEach(async () => {
    await w.killServer();
    for (const f of ["daemon-owner.lock.db", "daemon-spawn.lock.db"]) rmSync(join(w.data, f), { recursive: true, force: true, maxRetries: 10, retryDelay: 200 });
  });
  after(() => w.stop());
  const upOrSkip = async (t) => {
    const r = await w.cliBare({}, "daemon", "up", "--verbose");
    if (r.stdout.startsWith("Skipping daemon start (container)")) { t.skip("this host counts as a container"); return null; }
    return r;
  };

  test("a lock file that is not a database is thrown away and the server starts", async (t) => {
    writeFileSync(join(w.data, "daemon-owner.lock.db"), "this is not a database at all. ".repeat(60));
    const r = await upOrSkip(t);
    if (!r) return;
    assert.deepEqual([r.status, r.stdout], [0, "Daemon is running.\n"], r.stderr);
    assert.deepEqual(JSON.parse(readFileSync(join(w.data, "daemon-owner.lock.db.owner"), "utf8")), { pid: w.pidfile().pid });
  });

  test("a data dir that can't hold the lock still gets a server, and the log says so", async (t) => {
    mkdirSync(join(w.data, "daemon-owner.lock.db"));
    const r = await upOrSkip(t);
    if (!r) return;
    assert.deepEqual([r.status, r.stdout], [0, "Daemon is running.\n"], r.stderr);
    const [event] = w.logged("daemon.ownership.unavailable");
    assert.equal(event.level, "error");
    assert.equal(event.dataDir, w.data);
  });

  test("a second server on the same data dir gives up at once", async (t) => {
    const r = await upOrSkip(t);
    if (!r) return;
    const first = w.pidfile().pid;
    const second = spawn(SERVER[0], SERVER.slice(1), { env: { ...w.env, SCRYBE_DAEMON_PORT: "0" }, stdio: "ignore", windowsHide: true });
    const code = await new Promise((resolve) => second.on("exit", resolve));
    assert.ok(code === 0 || code === 1, `exit ${code}`);
    assert.equal(w.pidfile().pid, first);
    assert.ok(await w.health());
  });

  test("while another process is starting a server, up waits for that one and starts none", async (t) => {
    const db = new DatabaseSync(join(w.data, "daemon-spawn.lock.db"));
    db.exec("BEGIN IMMEDIATE");
    try {
      const r = await upOrSkip(t);
      if (!r) return;
      assert.equal(r.status, 1);
      assert.match(r.stderr, /Daemon did not become healthy \(health-timeout\)/);
      assert.equal(w.pidfile(), null);
      const [event] = w.logged("daemon.spawn.contended");
      assert.equal(event.level, "warn");
      assert.equal(event.heldByPid, null);
    } finally {
      db.close();
    }
  });

  test("two starts at once end with one server", async (t) => {
    const [a, b] = await Promise.all([upOrSkip(t), upOrSkip(t)]);
    if (!a || !b) return;
    assert.deepEqual([a.status, b.status], [0, 0], a.stderr + b.stderr);
    assert.ok(await w.health());
    assert.equal(w.logged("daemon.start").filter((e) => e.pid === w.pidfile().pid).length, 1);
  });
});

describe("what a background server inherits", { skip: process.platform === "linux" ? false : "Linux only" }, () => {
  let w;
  before(async () => { w = await makeWorld(); await w.cli("projects"); });
  afterEach(() => w.killServer());
  after(() => w.stop());

  const VARS = {
    LANG: "C.UTF-8", HTTPS_PROXY: "", GIT_TERMINAL_PROMPT: "0", LANCE_IO_THREADS: "2", npm_config_registry: "http://registry.invalid", SCRYBE_CONTRACT_EXTRA: "1", CONTRACT_PASSED: "1",
    SCRYBE_DAEMON_ENV_PASSTHROUGH: "CONTRACT_PASSED",
    CONTRACT_UNRELATED: "1", GH_TOKEN: "x", HF_TOKEN: "x", AWS_SECRET_ACCESS_KEY: "x", GIT_DIR: "/elsewhere/.git", npm_config__authToken: "x", SCRYBE_PRESET_FOO: "x", OPENAI_API_KEY: "x",
  };
  const KEPT = ["PATH", "HOME", "LANG", "HTTPS_PROXY", "GIT_TERMINAL_PROMPT", "LANCE_IO_THREADS", "npm_config_registry", "SCRYBE_CONTRACT_EXTRA", "SCRYBE_DATA_DIR", "CONTRACT_PASSED", "CONTRACT_EMBED_KEY", "MALLOC_ARENA_MAX", "MALLOC_TRIM_THRESHOLD_"];
  const DROPPED = ["CONTRACT_UNRELATED", "GH_TOKEN", "HF_TOKEN", "AWS_SECRET_ACCESS_KEY", "GIT_DIR", "npm_config__authToken", "SCRYBE_PRESET_FOO", "OPENAI_API_KEY"];
  const checkNames = (names) => {
    assert.deepEqual(KEPT.filter((k) => !names.has(k)), [], "missing");
    assert.deepEqual(DROPPED.filter((k) => names.has(k)), [], "leaked");
  };
  const namesOf = (pid) => new Set(readFileSync(`/proc/${pid}/environ`, "latin1").split("\0").filter(Boolean).map((e) => e.split("=")[0]));
  const skipped = (t, r) => r.stdout.startsWith("Skipping daemon start (container)") && (t.skip("this host counts as a container"), true);

  test("a server started without the memory cap gets only what it needs", async (t) => {
    const r = await w.cliBare(VARS, "daemon", "up", "--verbose");
    if (skipped(t, r)) return;
    assert.deepEqual([r.status, r.stdout], [0, "Daemon is running.\n"], r.stderr);
    checkNames(namesOf(w.pidfile().pid));
    const event = w.logged("daemon.spawn.env-filtered").at(-1);
    assert.equal(event.dropped, DROPPED.length);
    assert.deepEqual(event.missingRefs, []);
    assert.equal(w.logged("daemon.cgroup-cap.skipped").at(-1).reason, "disabled-by-config");
  });

  test("with the cap, systemd-run gets the same request, and the values only through a private file", async (t) => {
    const bin = join(w.dir, "fakebin"), runtime = join(w.dir, "runtime"), seen = join(w.dir, "seen");
    for (const d of [bin, runtime, seen]) mkdirSync(d, { recursive: true });
    // Stands in for systemd-run: notes what it was asked, then fails, so the plain start follows.
    writeFileSync(join(bin, "systemd-run"), `#!/bin/sh
printf '%s\\n' "$@" > "${seen}/args"
for a in "$@"; do case "$a" in EnvironmentFile=*) f="\${a#EnvironmentFile=}"; cp -p "$f" "${seen}/env"; stat -c '%a' "$f" "\${f%/*}" > "${seen}/modes";; esac; done
exit 3
`, { mode: 0o755 });
    const vars = { ...VARS, PATH: `${bin}:${w.env.PATH}`, XDG_RUNTIME_DIR: runtime, SCRYBE_DAEMON_CGROUP_MAX_MB: "", CONTRACT_PASSED: "a \"b\" $c `d` \\e" };
    const r = await w.cliBare(vars, "daemon", "up", "--verbose");
    if (skipped(t, r)) return;
    // An empty cap setting counts as off in both builds, so the real check names one.
    assert.equal(r.status, 0, r.stderr);
    await w.killServer();
    const again = await w.cliBare({ ...vars, SCRYBE_DAEMON_CGROUP_MAX_MB: "5000" }, "daemon", "up", "--verbose");
    assert.deepEqual([again.status, again.stdout], [0, "Daemon is running.\n"], again.stderr);
    const args = readFileSync(join(seen, "args"), "utf8").split("\n").filter(Boolean);
    const end = args.indexOf("--");
    const unit = args.find((a) => a.startsWith("--unit="));
    assert.match(unit, /^--unit=scrybe-daemon-\d+-[0-9a-f]{8}\.service$/);
    const envFile = join(runtime, "scrybe", `${unit.slice("--unit=".length)}.env`);
    assert.deepEqual(args.slice(0, end).filter((a) => a !== unit), ["--user", "--quiet", "--collect", "--description=scrybe daemon (memory-capped)", "-p", "MemoryMax=5000M", "-p", "MemorySwapMax=0", "-p", "Restart=no", "-p", "KillMode=process", "-p", `WorkingDirectory=-${w.dir}`, "-p", `EnvironmentFile=${envFile}`]);
    assert.equal(readFileSync(join(seen, "modes"), "utf8"), "600\n700\n");
    const lines = readFileSync(join(seen, "env"), "utf8").split("\n").filter(Boolean);
    checkNames(new Set(lines.map((l) => l.split("=")[0])));
    assert.ok(lines.includes('CONTRACT_PASSED="a \\"b\\" \\$c \\`d\\` \\\\e"'), "the value is quoted for systemd");
    assert.equal(existsSync(envFile), false, "the file is gone once systemd-run has run");
    const fallback = w.logged("daemon.cgroup-cap.fallback").at(-1);
    assert.equal(fallback.reason, "systemd-run exited 3");
    assert.equal(`--unit=${fallback.unit}`, unit);
    checkNames(namesOf(w.pidfile().pid));
  });

  test("with nowhere private for the file, systemd-run gets names and no values", async (t) => {
    const bin = join(w.dir, "fakebin2"), seen = join(w.dir, "seen2");
    for (const d of [bin, seen]) mkdirSync(d, { recursive: true });
    writeFileSync(join(bin, "systemd-run"), `#!/bin/sh\nprintf '%s\\n' "$@" > "${seen}/args"\nexit 1\n`, { mode: 0o755 });
    const r = await w.cliBare({ ...VARS, PATH: `${bin}:${w.env.PATH}`, XDG_RUNTIME_DIR: "relative/dir", SCRYBE_DAEMON_CGROUP_MAX_MB: "5000" }, "daemon", "up", "--verbose");
    if (skipped(t, r)) return;
    assert.equal(r.status, 0, r.stderr);
    const args = readFileSync(join(seen, "args"), "utf8").split("\n");
    checkNames(new Set(args.filter((a) => a.startsWith("--setenv=")).map((a) => a.slice("--setenv=".length))));
    assert.ok(args.filter((a) => a.startsWith("--setenv=")).every((a) => !a.slice("--setenv=".length).includes("=")));
    assert.equal(w.logged("daemon.spawn.env-file-fallback").at(-1).reason, "runtime-dir-not-absolute");
  });
});

describe("a running server that lacks a token's variable", { skip: process.platform === "linux" ? false : "Linux only" }, () => {
  let w, gl;
  before(async () => {
    gl = await fakeGitlab();
    w = await makeWorld();
    await w.index("--full");
  });
  after(async () => { await w.stop(); gl.close(); });

  const WARNING = (name, data) => `[scrybe] warning: the running daemon doesn't have ${name}, so it can't read this source's token. Run \`scrybe daemon stop\`; the next scrybe call starts a daemon that has ${name} if that call's environment does. To avoid this, name the variable SCRYBE_<something>, list it in SCRYBE_DAEMON_ENV_PASSTHROUGH, or put it in ${data}/.env.\n`;
  const warnings = (r) => r.stderr.split("\n").filter((l) => l.includes("the running daemon doesn't have")).map((l) => `${l}\n`);
  const add = (id, variable, extra = {}) => w.cliBare({ [variable]: GITLAB_TOKEN, ...extra }, "source", "add", "-P", "demo", "-S", id, "--type", "ticket", "--url", gl.url, "--project", GITLAB_PROJECT, "--token", `\${${variable}}`);

  test("is warned about when a source is added or changed from the command line, and only then", async (t) => {
    const up = await w.cliBare({}, "daemon", "up", "--verbose");
    if (up.stdout.startsWith("Skipping daemon start (container)")) return t.skip("this host counts as a container");
    let r = await add("t1", "CONTRACT_PAT");
    assert.equal(r.status, 0, r.stderr);
    assert.deepEqual(warnings(r), [WARNING("CONTRACT_PAT", w.data)]);
    r = await add("t2", "SCRYBE_CONTRACT_PAT");
    assert.equal(r.status, 0, r.stderr);
    assert.deepEqual(warnings(r), [], "SCRYBE_ names always reach a server");
    r = await add("t3", "CONTRACT_PAT_3", { SCRYBE_DAEMON_ENV_PASSTHROUGH: "CONTRACT_PAT_3" });
    assert.deepEqual([r.status, warnings(r)], [0, []], r.stderr);
    r = await w.cliBare({ CONTRACT_PAT_4: GITLAB_TOKEN }, "source", "update", "-P", "demo", "-S", "t2", "--token", "${CONTRACT_PAT_4}");
    assert.deepEqual([r.status, warnings(r)], [0, [WARNING("CONTRACT_PAT_4", w.data)]], r.stderr);
  });

  test("is not warned about with no server running", async () => {
    await w.killServer();
    const r = await w.cliBare({ CONTRACT_PAT_5: GITLAB_TOKEN }, "source", "update", "-P", "demo", "-S", "t2", "--token", "${CONTRACT_PAT_5}");
    assert.deepEqual([r.status, warnings(r)], [0, []], r.stderr);
  });

  test("says so to a search, in list_projects and in status, and how to fix it", async (t) => {
    const up = await w.cliBare({ CONTRACT_EMBED_KEY: undefined }, "daemon", "up", "--verbose");
    if (up.stdout.startsWith("Skipping daemon start (container)")) return t.skip("this host counts as a container");
    const remedy = ". The daemon only has the environment it was started with: run `scrybe daemon stop` and the next scrybe call starts one that has CONTRACT_EMBED_KEY, as long as that call's environment (or <DATA_DIR>/.env) has it. Names starting with SCRYBE_, and names listed in SCRYBE_DAEMON_ENV_PASSTHROUGH, reach the daemon even before config references them";
    const unset = `env var CONTRACT_EMBED_KEY not set (referenced in scrybe config)${remedy}`;
    const c = w.client();
    await c.hello();
    const r = await c.call("search_code", { project_id: "demo", query: "widget" });
    assert.deepEqual([r.isError, r.value], [true, { error: unset }]);
    const [source] = (await c.call("list_projects")).value[0].sources;
    assert.equal(source.searchable_reason, `Requires env var CONTRACT_EMBED_KEY (model: fake-model) — not set in current environment${remedy}`);
    assert.equal((await c.call("status")).value.credential_error_message, `code_preset: ${unset}; text_preset: ${unset}`);
    await w.killServer();
    assert.deepEqual((await w.cliBare({ CONTRACT_EMBED_KEY: undefined }, "search", "code", "-P", "demo", "widget")).stderr, "[scrybe] env var CONTRACT_EMBED_KEY not set (referenced in scrybe config)\n");
  });

  test("a token check on the command line doesn't talk about the server", async () => {
    const r = await w.cliBare({}, "source", "add", "-P", "demo", "-S", "t9", "--type", "ticket", "--url", gl.url, "--project", GITLAB_PROJECT, "--token", "${CONTRACT_NOT_SET}");
    assert.equal(r.status, 1);
    assert.match(r.stderr, /references env var CONTRACT_NOT_SET which is not set\. Set it in your environment or in <DATA_DIR>\/\.env: CONTRACT_NOT_SET=<your-token>\n/);
    assert.doesNotMatch(r.stderr, /The daemon only/);
  });
});

describe("the status command", () => {
  let w;
  // The first command after an index may print a one-time notice, so it runs before anything is compared.
  before(async () => { w = await makeWorld(); await w.index("--full"); await w.cli("projects"); });
  after(() => w.stop());

  const lines = (r) => r.stdout.split("\n").slice(0, -1).filter((l) => !l.startsWith("Mode "));
  const SOURCE_KEYS = ["sourceId", "chunks", "lastIndexed", "sizeBytes", "versionCount", "flags", "healthFlag"];

  test("--json without a server has the versioned shape", async () => {
    const r = await w.cli("status", "--json");
    assert.equal(r.status, 0, r.stderr);
    const s = JSON.parse(r.stdout);
    assert.deepEqual(Object.keys(s), ["schemaVersion", "scrybeVersion", "dataDir", "daemon", "projects"]);
    assert.equal(s.schemaVersion, 1);
    assert.equal(typeof s.scrybeVersion, "string");
    assert.deepEqual(Object.keys(s.dataDir), ["path", "sizeBytes"]);
    assert.equal(s.dataDir.path, w.data);
    assert.ok(Number.isInteger(s.dataDir.sizeBytes) && s.dataDir.sizeBytes > 0);
    assert.deepEqual(s.daemon, { running: false });
    assert.equal(s.projects.length, 1);
    assert.deepEqual(Object.keys(s.projects[0]), ["id", "sources"]);
    assert.equal(s.projects[0].id, "demo");
    const [src] = s.projects[0].sources;
    assert.deepEqual(Object.keys(src), SOURCE_KEYS);
    assert.equal(src.sourceId, "primary");
    assert.ok(Number.isInteger(src.chunks) && src.chunks > 0);
    assert.match(src.lastIndexed, /^\d{4}-\d\d-\d\dT/);
    assert.ok(src.sizeBytes > 0 && src.versionCount >= 1);
    assert.deepEqual([src.flags, src.healthFlag], [[], null]);
  });

  test("-P prints the project with its branches, then the data dir", async () => {
    for (const verb of ["status", "ps"]) {
      const r = await w.cli(verb, "-P", "demo");
      assert.equal(r.status, 0, r.stderr);
      const tail = `\nData dir: ${w.data}\n`;
      assert.ok(r.stdout.endsWith(tail), r.stdout.slice(-200));
      const project = JSON.parse(r.stdout.slice(0, -tail.length + 1));
      assert.deepEqual(Object.keys(project), ["id", "description", "sources"]);
      assert.equal(project.description, "A demo");
      const [src] = project.sources;
      const keys = Object.keys(src);
      assert.deepEqual(keys.slice(0, 4), ["source_id", "source_config", "table_name", "last_indexed"]);
      assert.equal(keys.at(-1), "branches_indexed");
      assert.deepEqual(src.branches_indexed, [w.main]);
    }
    const r = await w.cli("status", "-P", "nope");
    assert.deepEqual([r.status, r.stdout, r.stderr], [1, "", "Project 'nope' not found\n"]);
  });

  test("the plain text has the same lines in the same places", async () => {
    const r = await w.cli("status");
    assert.deepEqual([r.status, r.stderr], [0, ""]);
    const l = lines(r);
    assert.equal(l[0].indexOf("DATA_DIR:"), 40);
    assert.match(l[0], /^Scrybe v\S+ +DATA_DIR: /);
    assert.ok(l[0].endsWith(`DATA_DIR: ${w.data}`));
    assert.equal(l[1], "");
    assert.ok(l[2].startsWith("Daemon         ○ not running"), l[2]);
    assert.equal(l[3], "Auto-GC        ● enabled · 5m idle / 15% ratio");
    assert.equal(l[4], "Projects       1 registered");
    assert.equal(l[5], `  ${"PROJECT".padEnd(20)}${"SOURCE".padEnd(18)}${"CHUNKS".padStart(8)}  ${"SIZE".padEnd(10)}${"HEALTH".padEnd(12)}${"LAST INDEXED".padEnd(14)}LAST GC`);
    assert.match(l[6], /^ {2}demo {16}primary {11} *[\d,]+ {2}.{10}Healthy {5}just now {6}—$/);
    assert.equal(l.length, 7);
  });

  test("--projects leaves out the daemon and auto-gc lines", async () => {
    const l = lines(await w.cli("status", "--projects"));
    assert.equal(l[2], "Projects       1 registered");
    assert.equal(l.length, 5);
  });

  test("only five projects show without --all", async () => {
    for (let i = 1; i <= 6; i++) await w.cli("project", "add", "--id", `empty${i}`);
    let l = lines(await w.cli("status", "--projects"));
    assert.equal(l[2], "Projects       7 registered");
    assert.equal(l.at(-1), "  (2 more — use --all)");
    l = lines(await w.cli("status", "--projects", "-a"));
    assert.ok(!l.some((x) => x.includes("more — use --all")));
    for (let i = 1; i <= 6; i++) await w.cli("project", "remove", `empty${i}`);
  });

  test("with a server running it reports the server", async () => {
    const c = w.client();
    await c.hello();
    await c.toolNames();
    const pid = w.pidfile().pid;
    const s = JSON.parse((await w.cli("status", "--json")).stdout);
    assert.deepEqual(Object.keys(s.daemon), ["running", "pid", "uptimeMs", "activeJobs", "clientCount", "mode", "gracePeriodRemainingMs", "draining"]);
    assert.equal(s.daemon.running, true);
    assert.equal(s.daemon.pid, pid);
    assert.ok(Number.isInteger(s.daemon.uptimeMs) && s.daemon.uptimeMs >= 0);
    assert.ok(Number.isInteger(s.daemon.activeJobs) && Number.isInteger(s.daemon.clientCount));
    assert.match(s.daemon.mode, /^(on-demand|always-on)$/);
    assert.ok(s.daemon.gracePeriodRemainingMs === null || typeof s.daemon.gracePeriodRemainingMs === "number");
    assert.equal(s.daemon.draining, false);

    const text = await w.cli("status");
    const l = text.stdout.split("\n");
    assert.match(l[2], new RegExp(`^Daemon {9}● running · PID ${pid} · uptime \\d+m · \\d+ clients?( · grace in ~\\d+m)? · \\d+ jobs active$`));
    assert.match(l[3], /^Mode {11}(on-demand|always-on)/);
  });

  test("the live dashboard is not in this build", { skip: BUILD === "rust" ? false : "today's build draws one" }, async () => {
    const r = await w.cli("status", "--watch");
    assert.equal(r.status, 1);
    assert.equal(r.stdout, "");
    assert.match(r.stderr, /^\[scrybe\] .*not available in this build yet/);
  });
});

describe("the daemon start, restart and status commands", () => {
  let w;
  const running = (pid) => { try { process.kill(pid, 0); return true; } catch { return false; } };
  before(async () => { w = await makeWorld(); await w.cli("projects"); });
  after(() => w.stop());

  test("the old status says it is deprecated, then what it knows", async () => {
    const note = "[scrybe] 'daemon status' is deprecated — use 'scrybe status' instead (will be removed in v2.0)\n";
    let r = await w.cli("daemon", "status");
    assert.deepEqual([r.status, r.stdout, r.stderr], [0, "Daemon is not running.\n", note]);

    const c = w.client();
    await c.hello();
    await c.toolNames();
    r = await w.cli("daemon", "status");
    assert.equal(r.status, 0, r.stderr);
    assert.equal(r.stderr, note);
    assert.equal(r.stdout.trimEnd().split("\n").length, 1);
    assert.equal(JSON.parse(r.stdout).pid, w.pidfile().pid);
  });

  test("start refuses while a server runs", async () => {
    const r = await w.cli("daemon", "start");
    assert.deepEqual([r.status, r.stdout, r.stderr], [1, "", "[scrybe] Daemon is already running. Use 'scrybe status' to check.\n"]);
  });

  test("restart stops the running server and serves from the same terminal", async () => {
    const old = w.pidfile().pid;
    const restart = spawn(CLI[0], [...CLI.slice(1), "daemon", "restart"], { env: w.env, stdio: "ignore", windowsHide: true });
    const exited = new Promise((resolve) => restart.on("exit", resolve));
    try {
      await until(async () => w.pidfile()?.pid === restart.pid && (await w.health()), 40_000, "the restarted server");
      assert.notEqual(w.pidfile().pid, old);
      assert.ok(!running(old), "the old server is gone");
    } finally {
      restart.kill("SIGTERM");
      await exited;
    }
    // Windows has no SIGTERM: kill() ends the process outright, so it can't remove its pidfile.
    if (process.platform !== "win32") await until(() => w.pidfile() === null, 20_000, "the pidfile to go");
  });
});

describe("the index command", () => {
  let w;
  // The first command on a fresh data dir may print a one-time notice, so it runs before anything is compared.
  before(async () => {
    w = await makeWorld();
    const file = join(w.data, "projects.json");
    const projects = JSON.parse(readFileSync(file, "utf8"));
    projects[0].sources.push({ source_id: "second", source_config: { type: "code", root_path: w.repo, languages: [] } });
    writeFileSync(file, JSON.stringify(projects, null, 2));
    await w.cli("projects");
  });
  after(() => w.stop());

  // Progress is rewritten in place with carriage returns; only the lines that stay are compared.
  const text = (r) => r.stdout.replace(/\r[^\r\n]*/g, "");
  const COUNTS = "\\d+ chunks indexed, \\d+ files reindexed, \\d+ files removed";

  test("one source prints its own result line", async () => {
    let r = await w.cli("index", "-P", "demo", "-S", "primary");
    assert.equal(r.status, 0, r.stderr);
    assert.match(text(r), new RegExp(`^Indexing demo/primary \\(incremental\\)\\.\\.\\.\\n\\n {2}\\[primary\\] Done: [1-9]\\d* chunks indexed, 2 files reindexed, 0 files removed\\n$`));
    r = await w.cli("index", "-P", "demo", "--source-ids", "primary");
    assert.equal(text(r), "Indexing demo/primary (incremental)...\n\n  [primary] Done: 0 chunks indexed, 0 files reindexed, 0 files removed\n");
    r = await w.cli("index", "-P", "demo", "-S", "primary", "--full");
    assert.match(text(r), /^Indexing demo\/primary \(full\)\.\.\.\n\n {2}\[primary\] Done: [1-9]\d* chunks indexed, 2 files reindexed, 0 files removed\n$/);
  });

  test("several sources add a total", async () => {
    const r = await w.cli("index", "-P", "demo", "-S", "primary, second", "-I");
    assert.equal(r.status, 0, r.stderr);
    assert.match(text(r), new RegExp(`^Indexing demo/primary, demo/second \\(incremental\\)\\.\\.\\.\\n\\n {2}\\[primary\\] Done: ${COUNTS}\\n\\n {2}\\[second\\] Done: [1-9]\\d* chunks indexed, 2 files reindexed, 0 files removed\\n\\nTotal: [1-9]\\d* chunks indexed, 2 files reindexed, 0 files removed\\n$`));
  });

  test("a whole project is indexed source by source", async () => {
    const r = await w.cli("index", "-P", "demo");
    assert.equal(r.status, 0, r.stderr);
    assert.equal(text(r), "Indexing 'demo' (all sources) (incremental)...\n\nDone (2 source(s)): 0 chunks indexed, 0 files reindexed, 0 files removed\n");
  });

  test("--all goes through every project", async () => {
    const r = await w.cli("index", "--all", "-P", "ignored");
    assert.equal(r.status, 0, r.stderr);
    assert.ok(r.stderr.includes("Warning: --project-id is ignored when --all is specified\n"), r.stderr);
    assert.equal(text(r), "Incrementally reindexing all 1 project(s)...\n\n── demo (2 source(s))\n\n  Done (2 source(s)): 0 chunks indexed, 0 files reindexed, 0 files removed\n\nAll projects processed. All succeeded.\n");
  });

  test("bad arguments are named", async () => {
    let r = await w.cli("index");
    assert.deepEqual([r.status, r.stdout, r.stderr], [1, "", "--project-id is required (or use --all to reindex everything)\n"]);
    r = await w.cli("index", "-P", "demo", "--full");
    assert.deepEqual([r.status, r.stdout, r.stderr], [1, "", "Error: --full requires --source-ids (e.g. --source-ids primary,gitlab-issues)\n"]);
    r = await w.cli("index", "-P", "nope", "-S", "primary");
    assert.equal(r.status, 1);
    assert.equal(text(r), "Indexing nope/primary (incremental)...\n");
    assert.match(r.stderr, /^scrybe error: Error: .*nope/);
    r = await w.cli("index", "-P", "demo", "-S", "nope");
    assert.equal(r.status, 1);
    assert.match(r.stderr, /^scrybe error: Error: .*nope/);
  });
});

describe("the index command with a server running", () => {
  let w, c;
  before(async () => {
    w = await makeWorld();
    await w.cli("projects");
    c = w.client();
    await c.hello();
    await c.toolNames();
  });
  after(() => w.stop());

  test("--detach prints the job id, and the server lists that job", async () => {
    const r = await w.cliLive("index", "-P", "demo", "-S", "primary", "--detach");
    assert.equal(r.status, 0, r.stderr);
    const id = r.stdout.match(/^Job \w+: ([0-9a-f]{8})( \(queue position: \d+\))?\n$/)?.[1];
    assert.ok(id, r.stdout);
    const seen = await until(async () => (await c.call("list_jobs", {})).value?.jobs.find((j) => j.job_id === id), 30_000, "the job in the server's list");
    assert.equal(seen.project_id, "demo");
    await until(async () => (await c.call("reindex_status", { job_id: id })).value?.status === "done", 60_000, "the job to finish");
  });

  test("a followed job ends with Done.", async () => {
    const r = await w.cliLive("index", "-P", "demo", "-S", "primary", "--full");
    assert.equal(r.status, 0, r.stderr);
    const shown = r.stdout.replace(/\r[^\r\n]*/g, "");
    assert.match(shown, /^Indexing demo\/primary \(full\)\.\.\. \(job_id: [0-9a-f]{8}\)\n\nDone\.\n$/);
  });
});

describe("the deprecated forms", () => {
  let w;
  // The first command after an index may print a one-time notice, so it runs before anything is compared.
  before(async () => { w = await makeWorld(); await w.index("--full"); await w.cli("projects"); });
  after(() => w.stop());

  const note = (old, now) => `[deprecated] '${old}' renamed to '${now}'; will be removed in v1.0\n`;
  const json = (r) => JSON.parse(r.stdout);

  test("a bare search works and says it was renamed", async () => {
    const r = await w.cli("search", "frobnicateWidget", "--project-id", "demo", "--top-k", "3");
    assert.equal(r.status, 0, r.stderr);
    assert.match(r.stdout, /src\/widget\.ts/);
    assert.equal(r.stderr, note("search <query>", "search code <query>"));
    const several = await w.cli("search", "widen", "the", "widget", "--project-id", "demo");
    assert.equal(several.status, 0, several.stderr);
    assert.equal(several.stderr, note("search <query>", "search code <query>"));
  });

  test("the warning can be switched off", async () => {
    const r = await w.cliWith({ SCRYBE_NO_DEPRECATION_WARNING: "1" }, "search", "frobnicateWidget", "--project-id", "demo");
    assert.equal(r.status, 0, r.stderr);
    assert.equal(r.stderr, "");
    assert.match(r.stdout, /src\/widget\.ts/);
  });

  test("a bare search without a project says what to type", async () => {
    const r = await w.cli("search", "foo", "bar");
    assert.deepEqual([r.status, r.stdout, r.stderr], [1, "", "[scrybe] Missing project ID. Try: scrybe search code -P <id> \"foo bar\"  (run 'scrybe project list' to see ids)\n"]);
    const bad = await w.cli("search", "x", "--project-id", "nope");
    assert.equal(bad.status, 1);
    assert.equal(bad.stdout, "");
    assert.ok(bad.stderr.startsWith(note("search <query>", "search code <query>")), bad.stderr);
    assert.match(bad.stderr, /\n\[scrybe\] .*nope/);
  });

  test("pin list, add, remove and clear map onto the branch commands", async () => {
    let r = await w.cli("pin", "add", "--project-id", "demo", "side", "other");
    assert.equal(r.status, 0, r.stderr);
    assert.deepEqual({ ...json(r), ignore_warnings: undefined }, { branches: ["side", "other"], added: ["side", "other"], warnings: [], ignore_warnings: undefined });
    assert.ok(r.stderr.startsWith(note("pin add", "branch pin")), r.stderr);
    assert.match(r.stderr, /has no \.scrybeignore/);

    r = await w.cli("pin", "list", "--project-id", "demo");
    assert.deepEqual([r.status, r.stderr], [0, note("pin list", "branch list --pinned")]);
    assert.deepEqual(json(r), [{ source_id: "primary", branches: ["side", "other"] }]);

    r = await w.cli("pin", "remove", "--project-id", "demo", "other");
    assert.deepEqual([r.status, r.stderr], [0, note("pin remove", "branch unpin")]);
    assert.deepEqual(json(r), { branches: ["side"], removed: ["other"] });

    r = await w.cliInput("n\n", "pin", "clear", "--project-id", "demo");
    assert.deepEqual([r.status, r.stdout, r.stderr], [0, "Clear all pinned branches for demo/primary? [y/N] Aborted.\n", note("pin clear", "branch unpin --all")]);
    r = await w.cli("pin", "clear", "--project-id", "demo", "--yes");
    assert.deepEqual([r.status, r.stderr], [0, note("pin clear", "branch unpin --all")]);
    assert.deepEqual(json(r), { branches: [], removed: ["side"] });
  });

  test("pin commands need their options", async () => {
    let r = await w.cli("pin", "list");
    assert.deepEqual([r.status, r.stdout, r.stderr], [1, "", "error: required option '--project-id <id>' not specified\n"]);
    r = await w.cli("pin", "add", "--project-id", "demo");
    assert.deepEqual([r.status, r.stdout, r.stderr], [1, "", "error: missing required argument 'branches'\n"]);
    r = await w.cli("pin", "list", "--project-id", "nope");
    assert.equal(r.status, 1);
    assert.equal(r.stderr, `${note("pin list", "branch list --pinned")}scrybe error: Error: Project 'nope' not found\n`);
  });

  test("completion prints each shell's script unchanged", async () => {
    for (const shell of ["bash", "zsh", "powershell"]) {
      const r = await w.cli("completion", shell);
      assert.equal(r.status, 0, r.stderr);
      assert.equal(r.stdout, readFileSync(new URL(`./completions/${shell}.txt`, import.meta.url), "utf8"), shell);
    }
    const r = await w.cli("completion", "fish");
    assert.deepEqual([r.status, r.stdout, r.stderr], [1, "", "Unknown shell: fish. Supported: bash, zsh, powershell\n"]);
  });
});

describe("bare scrybe", () => {
  let w, repo;
  const setRoot = (root) => {
    const file = join(w.data, "projects.json");
    const projects = JSON.parse(readFileSync(file, "utf8"));
    projects[0].sources[0].source_config.root_path = root;
    writeFileSync(file, JSON.stringify(projects, null, 2));
  };
  // The first command on a fresh data dir may print a one-time notice, so it runs before anything is compared.
  before(async () => { w = await makeWorld(); repo = realpathSync(w.repo); await w.cli("projects"); });
  after(() => w.stop());

  test("outside a git repository it says so and exits 1", async () => {
    const r = await w.cliAt(w.dir);
    assert.deepEqual([r.status, r.stdout, r.stderr], [1, "", "Not a git repository. Run `scrybe init` to set up scrybe.\n"]);
  });

  test("in a repository that isn't registered it points to init", async () => {
    setRoot(join(w.dir, "somewhere-else"));
    const r = await w.cliAt(repo);
    assert.deepEqual([r.status, r.stdout, r.stderr], [0, "Repo not yet registered. Run:\n  scrybe init          # full wizard (recommended)\n", ""]);
  });

  test("in a registered repository it lists what to try next", async () => {
    setRoot(repo);
    const r = await w.cliAt(repo);
    assert.deepEqual([r.status, r.stdout, r.stderr], [0, "Repo already registered in scrybe. Try:\n  scrybe index -P <id>\n  scrybe search code -P <id> \"your query\"\n  scrybe status\n", ""]);
  });
});

describe("per-phase memory records", () => {
  const PHASE_KEYS = ["branch", "durationMs", "endRssBytes", "event", "final", "jobId", "level", "mode", "outcome", "peakRssBytes", "phase", "pid", "projectId", "seq", "sourceId", "startRssBytes", "ts", "work"];
  const INTENT_KEYS = ["branch", "event", "jobId", "level", "mode", "pid", "projectId", "rssBytes", "sourceId", "stage", "ts"];
  const read = (w) => readFileSync(join(w.data, "phase-log.jsonl"), "utf8").trim().split("\n").map((l) => JSON.parse(l));
  const phases = (records) => records.filter((r) => r.event === "indexer.phase");
  const finals = (records) => phases(records).filter((r) => r.final).map((r) => r.phase);

  function assertPhaseShape(r) {
    assert.deepEqual(Object.keys(r).sort(), PHASE_KEYS);
    assert.equal(r.level, "info");
    assert.ok(["ok", "error", "cancelled"].includes(r.outcome));
    assert.equal(typeof r.work, "object");
    assert.ok(Number.isInteger(r.seq) && Number.isInteger(r.durationMs) && r.durationMs >= 0);
    assert.equal(typeof r.final, "boolean");
    if (process.platform === "linux") {
      for (const k of ["startRssBytes", "peakRssBytes", "endRssBytes"]) assert.ok(Number.isInteger(r[k]) && r[k] > 1_000_000, `${k}: ${r[k]}`);
      assert.ok(r.peakRssBytes >= r.startRssBytes && r.peakRssBytes >= r.endRssBytes);
    }
  }

  describe("a full index from the command line", () => {
    let w, records;
    before(async () => {
      w = await makeWorld();
      await w.index("--full");
      records = read(w);
    });
    after(() => w.stop());

    test("writes one record per phase, in order, with the same keys", () => {
      for (const r of phases(records)) assertPhaseShape(r);
      const order = finals(records);
      for (const name of ["preflight_health", "scan", "diff", "stale_apply", "chunk_embed", "compact", "prune_orphans"]) assert.ok(order.includes(name), `${name} missing from ${order}`);
      const at = (n) => order.indexOf(n);
      assert.ok(at("preflight_health") < at("scan") && at("scan") < at("diff") && at("diff") < at("stale_apply") && at("stale_apply") < at("chunk_embed") && at("chunk_embed") < at("compact") && at("compact") < at("prune_orphans"), order.join(","));
      assert.ok(phases(records).every((r) => r.jobId === null && r.projectId === "demo" && r.sourceId === "primary" && r.mode === "full" && r.branch === w.main));
      assert.equal(new Set(records.map((r) => r.pid)).size, 1);
      assert.ok(Number.isInteger(records[0].pid) && records[0].pid > 0);
    });

    test("says what the job was told to do, before and after the scan", () => {
      const intents = records.filter((r) => r.event === "indexer.job.intent");
      assert.deepEqual(intents.map((r) => r.stage), ["started", "planned"]);
      const [started, planned] = intents;
      assert.deepEqual(Object.keys(started).sort(), [...INTENT_KEYS, "is_code"].sort());
      assert.equal(started.is_code, true);
      assert.deepEqual(Object.keys(planned).sort(), [...INTENT_KEYS, "files_total", "files_to_reindex", "files_to_remove", "is_non_head_branch", "provider"].sort());
      assert.equal(planned.files_total, 2);
      assert.equal(planned.files_to_reindex, 2);
      assert.equal(planned.provider, "api");
      assert.ok(records.indexOf(started) < records.findIndex((r) => r.phase === "scan"));
      assert.ok(records.indexOf(planned) > records.findIndex((r) => r.phase === "diff"));
      if (process.platform === "linux") assert.ok(started.rssBytes > 1_000_000);
    });

    test("carries each phase's own counters", () => {
      const work = (name) => phases(records).find((r) => r.phase === name && r.final).work;
      assert.deepEqual(work("preflight_health"), { table_state: "healthy", repaired: "none" });
      assert.deepEqual(work("scan"), { scan_kind: "working-tree", sources_found: 2, cursor_used: false });
      assert.deepEqual(work("diff"), { files_total: 2, prior_hashes: 0, files_to_reindex: 2, files_to_remove: 0 });
      assert.equal(work("stale_apply").files_to_reindex, 2);
      assert.ok(work("stale_apply").bytes_to_read > 0);
      assert.equal(work("compact").compacted, true);
      assert.ok(Number.isInteger(work("prune_orphans").orphans_removed));
      const embed = work("chunk_embed");
      assert.equal(embed.provider, "api");
      assert.equal(embed.zero_chunk_files, 0);
      assert.ok(embed.cumulative_chunks_prepared > 0 && embed.cumulative_files_seen === 2 && embed.cumulative_bytes_embedded > 0);
      assert.ok(Object.keys(embed).includes("batch_size"));
    });
  });

  describe("a job on the server", () => {
    let w, c, names, id;
    before(async () => {
      w = await makeWorld();
      c = w.client();
      await c.hello();
      names = await c.toolNames();
    });
    after(() => w.stop());

    test("stamps the job id and the server's pid", async (t) => {
      if (!names.includes("reindex_source")) return t.skip(`${BUILD} has no reindex_source yet`);
      const started = await c.call("reindex_source", { project_id: "demo", source_id: "primary" });
      id = started.value.job_id;
      assert.ok(id, JSON.stringify(started));
      await until(async () => ["done", "failed"].includes((await c.call("reindex_status", { job_id: id })).value?.status), 60_000, "the job");
      const records = read(w);
      assert.ok(phases(records).length >= 5);
      for (const r of phases(records)) assertPhaseShape(r);
      assert.ok(records.every((r) => r.jobId === id), JSON.stringify(records.map((r) => r.jobId)));
      assert.ok(finals(records).includes("chunk_embed"));
      assert.equal(records[0].pid, w.pidfile().pid);
      assert.ok(phases(records).every((r) => r.mode === "incremental"));
    });
  });
});

// ─── GitLab issues ────────────────────────────────────────────────────────────

const issueUrl = (iid) => `https://tracker.example.invalid/demo/tracker/-/issues/${iid}`;
const gitlabIssue = (iid, o) => ({
  iid, title: "", description: "", author: { username: "alice" }, updated_at: "2026-01-05T10:00:00.000Z", web_url: issueUrl(iid),
  state: "opened", labels: [], milestone: null, assignees: [], confidential: false, ...o,
});
const gitlabNote = (id, body, o = {}) => ({ id, body, author: { username: "bob" }, system: false, created_at: "2026-01-06T09:30:00.000Z", ...o });

const LONG_DESCRIPTION = Array.from({ length: 130 }, (_, i) => `Step ${i + 1}: check the gadget alignment`).join("\n");
const PAGED_NOTES = Array.from({ length: 100 }, (_, i) => gitlabNote(i + 1, `status changed ${i + 1}`, { system: true }));
PAGED_NOTES[6] = gitlabNote(7, "Page one note.", { author: { username: "dave" } });
PAGED_NOTES[99] = gitlabNote(100, "Last on page one.", { author: { username: "erin" } });
PAGED_NOTES.push(gitlabNote(101, "Page two note.", { author: { username: "frank" } }), gitlabNote(102, ""));

function seedGitlab(gl) {
  gl.state.issues = [
    gitlabIssue(1, {
      title: "Widget misaligned on resize", description: "The widget drifts left.\n\n- resize the window\n- watch the margin\n", labels: ["Bug", "UI"],
      assignees: [{ username: "alice" }, { username: "carol" }], milestone: { title: "Sprint 1", due_date: "2026-12-01" }, updated_at: "2026-01-05T10:00:00.000Z",
    }),
    gitlabIssue(2, { title: "Long checklist", description: LONG_DESCRIPTION, state: "closed", confidential: true, author: { username: "bob" }, updated_at: "2026-01-04T10:00:00.000Z" }),
    gitlabIssue(3, { title: "Überprüfung der Größe – 日本語 😀", description: "  Zeile eins\r\n\r\nЗвёздочка ★\rletzte Zeile  ", labels: ["größe"], milestone: { title: "Später", due_date: null }, updated_at: "2026-01-03T10:00:00.000Z" }),
    gitlabIssue(4, { title: "Pagination check", description: null, updated_at: "2026-01-02T10:00:00.000Z" }),
  ];
  gl.state.notes = {
    1: [
      gitlabNote(101, "Reproduced on the latest build.\r\nSee attached log.\r\n"),
      gitlabNote(102, "changed the description", { system: true }),
      gitlabNote(103, "   \n "),
      gitlabNote(104, "Fixed in the next release ✓ — thanks!", { author: { username: "carol" }, created_at: "" }),
    ],
    4: PAGED_NOTES,
  };
}

async function lanceModule() {
  const nm = process.env.SCRYBE_CONTRACT_NODE_MODULES ?? (CLI[1]?.endsWith("index.js") ? join(CLI[1], "..", "..", "..") : null);
  if (!nm) return null;
  try { return await import(pathToFileURL(join(nm, "@lancedb/lancedb/dist/index.js")).href); } catch { return null; }
}

/** Every row of the issues table, vectors included, in a stable order. */
async function knowledgeRows(w) {
  const lance = await lanceModule();
  if (!lance) return null;
  const table = JSON.parse(readFileSync(join(w.data, "projects.json"), "utf8"))[0].sources.find((s) => s.source_id === "issues").table_name;
  const t = await (await lance.connect(join(w.data, "lancedb"))).openTable(table);
  const cols = ["chunk_id", "project_id", "source_id", "item_path", "item_url", "item_type", "author", "timestamp", "content", "state", "labels", "assignees", "milestone", "confidential"];
  return (await t.query().toArray()).map((r) => ({ ...Object.fromEntries(cols.map((c) => [c, r[c]])), vector: Array.from(r.vector) })).sort(byId);
}

const summarize = (rows) => rows.map((r) => ({
  chunk_id: r.chunk_id, item_path: r.item_path, item_url: r.item_url, item_type: r.item_type, author: r.author, timestamp: r.timestamp,
  state: r.state, labels: r.labels, assignees: r.assignees, milestone: r.milestone, confidential: r.confidential,
  length: r.content.length, head: r.content.slice(0, 32),
}));

const sameVector = (row) => {
  const want = Array.from(Float32Array.from(vectorFor(row.content)));
  return row.vector.length === want.length && row.vector.every((x, i) => Math.abs(x - want[i]) < 1e-6);
};

const ticketSource = (gl) => ({ source_id: "issues", source_config: { type: "ticket", provider: "gitlab", base_url: gl.url, project_id: GITLAB_PROJECT, token: "${CONTRACT_GITLAB_TOKEN}" } });
const indexIssues = (w, ...extra) => w.cli("index", "-P", "demo", "-S", "issues", ...extra);

describe("GitLab issues", () => {
  let gl, w, rows1;
  const listUrl = (page, extra = "") => `/api/v4/projects/demo%2Ftracker/issues?state=all${extra}&per_page=100&page=${page}`;
  before(async () => {
    gl = await fakeGitlab();
    seedGitlab(gl);
    w = await makeWorld({ extraSources: [ticketSource(gl)], serverEnv: { CONTRACT_GITLAB_TOKEN: GITLAB_TOKEN } });
  });
  after(async () => { await w.stop(); gl.close(); });

  test("a full index writes the same rows, ids and metadata as today's build", async (t) => {
    const r = await indexIssues(w, "--full");
    assert.equal(r.status, 0, r.stderr + r.stdout);
    const log = gl.state.log;
    assert.ok(log.every((l) => l.auth === `Bearer ${GITLAB_TOKEN}` && l.contentType === "application/json"));
    assert.equal(log[0].url, listUrl(1));
    for (const iid of [1, 2, 3, 4]) {
      assert.ok(log.some((l) => l.url === `/api/v4/projects/demo%2Ftracker/issues/${iid}`), `no request for issue ${iid}`);
      assert.ok(log.some((l) => l.url === `/api/v4/projects/demo%2Ftracker/issues/${iid}/notes?per_page=100&page=1`), `no notes request for issue ${iid}`);
    }
    assert.ok(log.some((l) => l.url === "/api/v4/projects/demo%2Ftracker/issues/4/notes?per_page=100&page=2"), "the second page of notes was not read");
    rows1 = await knowledgeRows(w);
    if (!rows1) return t.skip("no LanceDB module to read the table with: set SCRYBE_CONTRACT_NODE_MODULES");
    assert.deepEqual(summarize(rows1), EXPECTED_FULL);
    assert.ok(rows1.every(sameVector), "a row's vector is not the embedding of its content");
  });

  test("the source is registered and its cursor saved", () => {
    const source = JSON.parse(readFileSync(join(w.data, "projects.json"), "utf8"))[0].sources.find((s) => s.source_id === "issues");
    assert.match(source.table_name, /^knowledge_[0-9a-f]{12}$/);
    assert.ok(source.last_indexed);
    assert.equal(source.source_config.token, "${CONTRACT_GITLAB_TOKEN}");
    assert.match(JSON.parse(readFileSync(join(w.data, "cursors", "demo__issues.json"), "utf8")).updated_after, /^\d{4}-\d\d-\d\dT[\d:.]+Z$/);
    const hashes = JSON.parse(readFileSync(join(w.data, "hashes", "demo__issues___all_.json"), "utf8"));
    assert.deepEqual(Object.keys(hashes).sort(), ["issues/1", "issues/2", "issues/3", "issues/4"]);
  });

  test("search_knowledge finds the indexed issues", async () => {
    const c = w.client();
    await c.hello();
    const { value, isError } = await c.call("search_knowledge", { project_id: "demo", query: "Pagination check", top_k: 20, source_id: "issues" });
    assert.equal(isError, false);
    const hit = value.find((h) => h.item_path === "issues/4");
    assert.equal(hit.item_type, "ticket");
    assert.equal(hit.item_url, issueUrl(4));
    assert.ok(value.some((h) => h.item_path === "issues/1#note_104" && h.item_type === "ticket_comment"));
  });

  test("an incremental run asks for what changed and updates only that issue", async (t) => {
    const cursor = JSON.parse(readFileSync(join(w.data, "cursors", "demo__issues.json"), "utf8")).updated_after;
    const since = new Date(Date.parse(cursor) - 60_000).toISOString();
    const changed = gl.state.issues.find((i) => i.iid === 3);
    changed.description = "Zeile eins, now rewritten.";
    changed.updated_at = "2099-01-01T00:00:00.000Z";
    gl.state.log.length = 0;
    const r = await indexIssues(w);
    assert.equal(r.status, 0, r.stderr + r.stdout);
    const log = gl.state.log.map((l) => l.url);
    assert.equal(log[0], listUrl(1, `&updated_after=${encodeURIComponent(since)}`));
    assert.deepEqual(log.slice(1).sort(), ["/api/v4/projects/demo%2Ftracker/issues/3", "/api/v4/projects/demo%2Ftracker/issues/3/notes?per_page=100&page=1"]);
    assert.notEqual(JSON.parse(readFileSync(join(w.data, "cursors", "demo__issues.json"), "utf8")).updated_after, cursor);
    const rows2 = await knowledgeRows(w);
    if (!rows2) return t.skip("no LanceDB module to read the table with: set SCRYBE_CONTRACT_NODE_MODULES");
    // The old rows of a changed issue stay until garbage collection.
    assert.deepEqual(summarize(rows2), EXPECTED_AFTER_CHANGE);
  });

  test("an unchanged tracker is read again but nothing is embedded", async () => {
    const before = w.fake.log.length;
    gl.state.log.length = 0;
    const r = await indexIssues(w);
    assert.equal(r.status, 0, r.stderr + r.stdout);
    assert.equal(w.fake.log.length, before);
    assert.ok(gl.state.log.every((l) => !/issues\/\d/.test(l.url)), JSON.stringify(gl.state.log));
  });
});

describe("GitLab issues, when the token fails", () => {
  let gl, w;
  before(async () => {
    gl = await fakeGitlab();
    seedGitlab(gl);
  });
  after(async () => { await w?.stop(); gl.close(); });

  test("an unset token variable fails before any request", async () => {
    w = await makeWorld({ extraSources: [ticketSource(gl)] });
    const r = await indexIssues(w, "--full");
    assert.notEqual(r.status, 0);
    assert.match(r.stderr + r.stdout, /env var CONTRACT_GITLAB_TOKEN not set \(referenced in scrybe config\)/);
    assert.equal(gl.state.log.length, 0);
    await w.stop();
  });

  test("a rejected token names the project and the fix", async () => {
    w = await makeWorld({ extraSources: [ticketSource(gl)], serverEnv: { CONTRACT_GITLAB_TOKEN: "not-the-token" } });
    const r = await indexIssues(w, "--full");
    assert.notEqual(r.status, 0);
    assert.ok((r.stderr + r.stdout).includes('GitLab token for project "demo" is expired or invalid (HTTP 401). Update it with: scrybe update-source --project-id demo --source-id <source-id> --gitlab-token <new-token>'), r.stderr + r.stdout);
  });
});

// ─── GitHub issues ────────────────────────────────────────────────────────────

const ghUrl = (n) => `https://github.example.invalid/acme/widgets/issues/${n}`;
const ghIssue = (number, o) => ({
  number, title: "", body: "", user: { login: "alice" }, state: "open", updated_at: "2026-01-05T10:00:00Z", html_url: ghUrl(number),
  labels: [], milestone: null, assignees: [], ...o,
});
const ghComment = (id, body, o = {}) => ({ id, body, user: { login: "bob" }, created_at: "2026-01-06T09:30:00Z", ...o });

const GH_PAGED_COMMENTS = Array.from({ length: 100 }, (_, i) => ghComment(i + 1, "   "));
GH_PAGED_COMMENTS[6] = ghComment(7, "Page one comment.", { user: { login: "dave" } });
GH_PAGED_COMMENTS[99] = ghComment(100, "Last on page one.", { user: { login: "erin" } });
GH_PAGED_COMMENTS.push(ghComment(101, "Page two comment.", { user: { login: "frank" } }), ghComment(102, null));

function seedGithub(gh) {
  gh.state.issues = [
    ghIssue(1, {
      title: "Widget misaligned on resize", body: "The widget drifts left.\n\n- resize the window\n- watch the margin\n", labels: [{ name: "Bug" }, { name: "UI" }],
      assignees: [{ login: "alice" }, { login: "carol" }], milestone: { title: "Sprint 1", due_on: "2026-12-01T00:00:00Z" },
    }),
    ghIssue(2, { title: "Long checklist", body: LONG_DESCRIPTION, state: "closed", user: { login: "bob" }, updated_at: "2026-01-04T10:00:00Z" }),
    ghIssue(3, { title: "Überprüfung der Größe – 日本語 😀", body: "  Zeile eins\r\n\r\nЗвёздочка ★\rletzte Zeile  ", labels: [{ name: "größe" }], user: null, updated_at: "2026-01-03T10:00:00Z" }),
    ghIssue(4, { title: "Fix the widget margin", body: "A pull request, not an issue.", pull_request: { url: "https://api.github.example.invalid/repos/acme/widgets/pulls/4" }, updated_at: "2026-01-03T11:00:00Z" }),
    ghIssue(5, { title: "Pagination check", body: null, updated_at: "2026-01-02T10:00:00Z" }),
  ];
  gh.state.comments = {
    1: [
      ghComment(101, "Reproduced on the latest build.\r\nSee attached log.\r\n"),
      ghComment(102, "Same here.", { user: null }),
      ghComment(103, "   \n "),
      ghComment(104, "Fixed in the next release ✓ — thanks!", { user: { login: "carol" }, created_at: "" }),
    ],
    4: [ghComment(201, "Looks good to me.")],
    5: GH_PAGED_COMMENTS,
  };
}

const githubSource = (gh) => ({ source_id: "issues", source_config: { type: "ticket", provider: "github", base_url: gh.url, project_id: GITHUB_PROJECT, token: "${CONTRACT_GITHUB_TOKEN}" } });
const SCOPES = "Ensure the token has Issues: Read-only and Metadata: Read-only scopes (fine-grained PAT) or repo/public_repo (classic PAT).";
const GH_LIST = "/repos/acme/widgets/issues";

describe("GitHub issues", () => {
  let gh, w, rows1;
  before(async () => {
    gh = await fakeGithub();
    seedGithub(gh);
    w = await makeWorld({ extraSources: [githubSource(gh)], serverEnv: { CONTRACT_GITHUB_TOKEN: GITHUB_TOKEN } });
  });
  after(async () => { await w.stop(); gh.close(); });

  test("a full index writes the same rows, ids and metadata as today's build, pull requests left out", async (t) => {
    const r = await indexIssues(w, "--full");
    assert.equal(r.status, 0, r.stderr + r.stdout);
    const log = gh.state.log;
    assert.ok(log.every((l) => l.auth === `Bearer ${GITHUB_TOKEN}` && l.accept === "application/vnd.github+json" && l.version === "2022-11-28"));
    assert.equal(log[0].url, `${GH_LIST}?state=all&per_page=100&page=1`);
    for (const n of [1, 2, 3, 5]) {
      assert.ok(log.some((l) => l.url === `${GH_LIST}/${n}`), `no request for issue ${n}`);
      assert.ok(log.some((l) => l.url === `${GH_LIST}/${n}/comments?per_page=100&page=1`), `no comments request for issue ${n}`);
    }
    assert.ok(log.some((l) => l.url === `${GH_LIST}/5/comments?per_page=100&page=2`), "the second page of comments was not read");
    assert.ok(log.every((l) => !l.url.includes("/issues/4")), "the pull request was fetched");
    rows1 = await knowledgeRows(w);
    if (!rows1) return t.skip("no LanceDB module to read the table with: set SCRYBE_CONTRACT_NODE_MODULES");
    assert.deepEqual(summarize(rows1), GITHUB_FULL);
    assert.ok(rows1.every(sameVector), "a row's vector is not the embedding of its content");
  });

  test("the source is registered and its cursor saved", () => {
    const source = JSON.parse(readFileSync(join(w.data, "projects.json"), "utf8"))[0].sources.find((s) => s.source_id === "issues");
    assert.match(source.table_name, /^knowledge_[0-9a-f]{12}$/);
    assert.ok(source.last_indexed);
    assert.equal(source.source_config.token, "${CONTRACT_GITHUB_TOKEN}");
    assert.match(JSON.parse(readFileSync(join(w.data, "cursors", "demo__issues.json"), "utf8")).updated_after, /^\d{4}-\d\d-\d\dT[\d:.]+Z$/);
    const hashes = JSON.parse(readFileSync(join(w.data, "hashes", "demo__issues___all_.json"), "utf8"));
    assert.deepEqual(Object.keys(hashes).sort(), ["issues/1", "issues/2", "issues/3", "issues/5"]);
  });

  test("an incremental run asks for what changed and updates only that issue", async (t) => {
    const cursor = JSON.parse(readFileSync(join(w.data, "cursors", "demo__issues.json"), "utf8")).updated_after;
    const since = new Date(Date.parse(cursor) - 60_000).toISOString();
    const changed = gh.state.issues.find((i) => i.number === 3);
    changed.body = "Zeile eins, now rewritten.";
    changed.updated_at = "2099-01-01T00:00:00Z";
    gh.state.log.length = 0;
    const r = await indexIssues(w);
    assert.equal(r.status, 0, r.stderr + r.stdout);
    const log = gh.state.log.map((l) => l.url);
    assert.equal(log[0], `${GH_LIST}?state=all&since=${encodeURIComponent(since)}&per_page=100&page=1`);
    assert.deepEqual(log.slice(1).sort(), [`${GH_LIST}/3`, `${GH_LIST}/3/comments?per_page=100&page=1`]);
    assert.notEqual(JSON.parse(readFileSync(join(w.data, "cursors", "demo__issues.json"), "utf8")).updated_after, cursor);
    const rows2 = await knowledgeRows(w);
    if (!rows2) return t.skip("no LanceDB module to read the table with: set SCRYBE_CONTRACT_NODE_MODULES");
    // The old rows of a changed issue stay until garbage collection.
    assert.deepEqual(summarize(rows2), GITHUB_AFTER_CHANGE);
  });

  test("an unchanged tracker is read again but nothing is embedded", async () => {
    const before = w.fake.log.length;
    gh.state.log.length = 0;
    const r = await indexIssues(w);
    assert.equal(r.status, 0, r.stderr + r.stdout);
    assert.equal(w.fake.log.length, before);
    assert.ok(gh.state.log.every((l) => !/issues\/\d/.test(l.url)), JSON.stringify(gh.state.log));
  });
});

describe("GitHub issues, when the API pushes back", () => {
  let gh, w;
  const listHits = () => gh.state.log.filter((l) => l.url.startsWith(`${GH_LIST}?`)).length;
  before(async () => {
    gh = await fakeGithub();
    seedGithub(gh);
    w = await makeWorld({ extraSources: [githubSource(gh)], serverEnv: { CONTRACT_GITHUB_TOKEN: GITHUB_TOKEN } });
  });
  after(async () => { await w.stop(); gh.close(); });

  test("a rate-limited first answer is waited out and retried", async (t) => {
    let left = 1;
    gh.state.intercept = (url) => (url.startsWith(`${GH_LIST}?`) && left-- > 0 ? { code: 429, headers: { "Retry-After": "1" } } : null);
    const r = await indexIssues(w, "--full");
    assert.equal(r.status, 0, r.stderr + r.stdout);
    assert.equal(listHits(), 2);
    const rows = await knowledgeRows(w);
    if (!rows) return t.skip("no LanceDB module to read the table with: set SCRYBE_CONTRACT_NODE_MODULES");
    assert.deepEqual(summarize(rows), GITHUB_FULL);
  });

  test("an exhausted quota with a reset time is waited out too", async () => {
    let left = 1;
    const reset = String(Math.floor(Date.now() / 1000));
    gh.state.intercept = (url) => (url.startsWith(`${GH_LIST}?`) && left-- > 0 ? { code: 403, headers: { "x-ratelimit-remaining": "0", "x-ratelimit-reset": reset } } : null);
    gh.state.log.length = 0;
    const r = await indexIssues(w, "--full");
    assert.equal(r.status, 0, r.stderr + r.stdout);
    assert.equal(listHits(), 2);
  });

  test("a limit that never lifts stops after three retries, naming the wait", async () => {
    gh.state.intercept = (url) => (url.startsWith(`${GH_LIST}?`) ? { code: 429, headers: { "Retry-After": "1" } } : null);
    gh.state.log.length = 0;
    const r = await indexIssues(w, "--full");
    assert.notEqual(r.status, 0);
    assert.ok((r.stderr + r.stdout).includes('GitHub API rate limit exceeded for project "demo". Retry after 1s.'), r.stderr + r.stdout);
    assert.equal(listHits(), 4);
  });

  test("a forbidden token without a rate limit fails at once", async () => {
    gh.state.intercept = (url) => (url.startsWith(`${GH_LIST}?`) ? { code: 403 } : null);
    gh.state.log.length = 0;
    const r = await indexIssues(w, "--full");
    assert.notEqual(r.status, 0);
    assert.ok((r.stderr + r.stdout).includes(`GitHub token for project "demo" lacks required permissions (HTTP 403). ${SCOPES}`), r.stderr + r.stdout);
    assert.equal(listHits(), 1);
  });
});

describe("GitHub issues, when the token fails", () => {
  let gh, w;
  before(async () => {
    gh = await fakeGithub();
    seedGithub(gh);
  });
  after(async () => { await w?.stop(); gh.close(); });

  test("an unset token variable fails before any request", async () => {
    w = await makeWorld({ extraSources: [githubSource(gh)] });
    const r = await indexIssues(w, "--full");
    assert.notEqual(r.status, 0);
    assert.match(r.stderr + r.stdout, /env var CONTRACT_GITHUB_TOKEN not set \(referenced in scrybe config\)/);
    assert.equal(gh.state.log.length, 0);
    await w.stop();
  });

  test("a rejected token names the project and the scopes", async () => {
    w = await makeWorld({ extraSources: [githubSource(gh)], serverEnv: { CONTRACT_GITHUB_TOKEN: "not-the-token" } });
    const r = await indexIssues(w, "--full");
    assert.notEqual(r.status, 0);
    assert.ok((r.stderr + r.stdout).includes(`GitHub token for project "demo" is invalid or expired (HTTP 401). ${SCOPES}`), r.stderr + r.stdout);
  });
});

// ─── Ticket sources: the server's own polling, and add_source ────────────────

const tickerEvents = (feed, pick = () => true) => feed.events.filter((e) => e.event === "watcher.event" && e.detail?.phase === "ticket-poller" && e.detail.enqueued === true && pick(e));
const hasIssue = (c, path) => async () => (await c.call("search_knowledge", { project_id: "demo", query: "Pagination check", top_k: 20, source_id: "issues" })).value?.some?.((h) => h.item_path === path);
const POLL_ENV = { CONTRACT_GITLAB_TOKEN: GITLAB_TOKEN, SCRYBE_DAEMON_NO_TICKET_FETCH: "0" };

/** Starts the server through a client and follows its events from the beginning. */
async function serverWithFeed(w) {
  const c = w.client();
  await c.hello();
  await c.rpc("tools/list");
  await until(() => w.pidfile(), 10_000, "the pidfile");
  return { c, feed: await watchEvents(`http://127.0.0.1:${w.pidfile().port}`) };
}

describe("ticket sources are polled by the server", () => {
  let gl, w, c, feed;
  before(async () => {
    gl = await fakeGitlab();
    seedGitlab(gl);
    w = await makeWorld({ extraSources: [ticketSource(gl)], serverEnv: { ...POLL_ENV, SCRYBE_DAEMON_TICKET_ACTIVE_MS: "1500", SCRYBE_DAEMON_TICKET_IDLE_MS: "1500" } });
    ({ c, feed } = await serverWithFeed(w));
  });
  after(async () => { feed?.stop(); await w.stop(); gl.close(); });

  test("a source never indexed is polled at once and its issues become searchable", async () => {
    const first = await until(() => tickerEvents(feed)[0], 30_000, "the first ticket poll");
    assert.equal(first.level, "info");
    assert.equal(first.projectId, "demo");
    assert.deepEqual(first.detail, { phase: "ticket-poller", sourceId: "issues", enqueued: true });
    await until(hasIssue(c, "issues/4"), 60_000, "the issues to be indexed");
    assert.ok(gl.state.log.length > 0 && gl.state.log.every((l) => l.auth === `Bearer ${GITLAB_TOKEN}`));
  });

  test("it polls again on the interval and then asks only for what changed", async () => {
    await until(() => tickerEvents(feed).length >= 2, 30_000, "a second ticket poll");
    await until(() => gl.state.log.some((l) => l.url.includes("updated_after=")), 30_000, "a request with a cursor");
  });
});

describe("ticket polling switched off", () => {
  let gl, w, c, feed;
  before(async () => {
    gl = await fakeGitlab();
    seedGitlab(gl);
    w = await makeWorld({ extraSources: [ticketSource(gl)], serverEnv: { ...POLL_ENV, SCRYBE_DAEMON_NO_TICKET_FETCH: "1", SCRYBE_DAEMON_TICKET_ACTIVE_MS: "300", SCRYBE_DAEMON_TICKET_IDLE_MS: "300" } });
    ({ c, feed } = await serverWithFeed(w));
  });
  after(async () => { feed?.stop(); await w.stop(); gl.close(); });

  test("nothing polls the tracker, though a run asked for by hand still reads it", async () => {
    await sleep(3000);
    assert.equal(tickerEvents(feed).length, 0);
    assert.equal(gl.state.log.length, 0);
    const started = await c.call("reindex_source", { project_id: "demo", source_id: "issues" });
    assert.ok(started.value?.job_id, JSON.stringify(started));
    await until(hasIssue(c, "issues/4"), 60_000, "the hand-started run to index the issues");
    assert.ok(gl.state.log.length > 0);
    assert.equal(tickerEvents(feed).length, 0);
  });
});

describe("a ticket source added while the server runs", () => {
  let gl, w, c, feed;
  before(async () => {
    gl = await fakeGitlab();
    seedGitlab(gl);
    w = await makeWorld({ serverEnv: { ...POLL_ENV, SCRYBE_DAEMON_TICKET_ACTIVE_MS: "600000", SCRYBE_DAEMON_TICKET_IDLE_MS: "600000" } });
    ({ c, feed } = await serverWithFeed(w));
  });
  after(async () => { feed?.stop(); await w.stop(); gl.close(); });

  test("is polled once its first run is queued, and not before", async () => {
    await sleep(2000);
    assert.equal(feed.events.filter((e) => e.detail?.phase?.startsWith("ticket-poller")).length, 0);
    const file = join(w.data, "projects.json");
    const projects = JSON.parse(readFileSync(file, "utf8"));
    projects[0].sources.push(ticketSource(gl));
    writeFileSync(file, JSON.stringify(projects, null, 2));
    const started = await c.call("reindex_source", { project_id: "demo", source_id: "issues" });
    assert.ok(started.value?.job_id, JSON.stringify(started));
    const polled = await until(() => tickerEvents(feed)[0], 30_000, "the new source to be polled");
    assert.equal(polled.detail.sourceId, "issues");
    await until(hasIssue(c, "issues/4"), 60_000, "the issues to be indexed");
  });
});

describe("a literal token", () => {
  let gl, w, feed;
  before(async () => {
    gl = await fakeGitlab();
    seedGitlab(gl);
    const literal = { ...ticketSource(gl), source_id: "literal" };
    literal.source_config.token = GITLAB_TOKEN;
    w = await makeWorld({ extraSources: [ticketSource(gl), literal], serverEnv: { ...POLL_ENV, SCRYBE_DAEMON_TICKET_ACTIVE_MS: "600000", SCRYBE_DAEMON_TICKET_IDLE_MS: "600000" } });
    ({ feed } = await serverWithFeed(w));
  });
  after(async () => { feed?.stop(); await w.stop(); gl.close(); });

  test("is warned about once, and a ${VAR} token is not", async () => {
    await until(() => tickerEvents(feed, (e) => e.detail.sourceId === "issues")[0] && tickerEvents(feed, (e) => e.detail.sourceId === "literal")[0], 30_000, "both sources to be polled");
    const warned = feed.events.filter((e) => e.detail?.phase === "ticket-poller.literal-token");
    assert.equal(warned.length, 1, JSON.stringify(warned));
    assert.equal(warned[0].level, "warn");
    assert.equal(warned[0].event, "watcher.event");
    assert.equal(warned[0].projectId, "demo");
    assert.deepEqual(warned[0].detail, {
      phase: "ticket-poller.literal-token",
      sourceId: "literal",
      literalTokenWarn: true,
      message: 'Source "literal" uses a literal token. Store the token in an env var (e.g. SCRYBE_GITLAB_TOKEN) and reference it as ${SCRYBE_GITLAB_TOKEN} to avoid exposing credentials in projects.json.',
    });
  });
});

/** What a failed tool call says, whether it came back as an error result or an error reply. */
const failureText = (r) => (r.rpcError ? r.rpcError.message : typeof r.value?.error === "string" ? r.value.error : r.text);
const wasRefused = (r) => r.isError === true || r.rpcError !== undefined;
const savedSources = (w) => JSON.parse(readFileSync(join(w.data, "projects.json"), "utf8"))[0].sources.map((s) => s.source_id);

// What the server adds to an unset-variable message depends on the platform it runs on.
const daemonRemedy = (name) => (process.platform === "linux"
  ? `. The daemon only receives variables your saved config already references, so restarting it alone won't help here: name the variable SCRYBE_<something>, list ${name} in SCRYBE_DAEMON_ENV_PASSTHROUGH, or put it in <DATA_DIR>/.env, then run \`scrybe daemon stop\`; or run \`scrybe daemon stop\`, then add the source with \`scrybe source add\` from a terminal that has ${name} set`
  : `. The daemon only has the environment it was started with: run \`scrybe daemon stop\` and the next scrybe call starts one that has ${name}, as long as that call's environment (or <DATA_DIR>/.env) has it`);

// The published TypeScript build masks this message as an internal error; its source now sends it to the caller. The Rust build must send it.
const unsetMessage = (actual, expected) => {
  assert.ok((BUILD !== "rust" && actual === "internal error") || actual === expected, actual);
};

const addGitlab = (gl, extra = {}) => ({ project_id: "demo", source_id: "tracker", source_type: "ticket", provider: "gitlab", url: gl.url, project: GITLAB_PROJECT, token: "${CONTRACT_GITLAB_TOKEN}", ...extra });
const addGithub = (gh, extra = {}) => ({ project_id: "demo", source_id: "tracker", source_type: "ticket", provider: "github", url: gh.url, project: GITHUB_PROJECT, token: "${CONTRACT_GITHUB_TOKEN}", ...extra });

describe("add_source checks a ticket token first", () => {
  let gl, gh, w, c, names;
  before(async () => {
    gl = await fakeGitlab();
    gh = await fakeGithub();
    w = await makeWorld({ serverEnv: { CONTRACT_GITLAB_TOKEN: "not-the-token", CONTRACT_GITHUB_TOKEN: "not-the-token" } });
    c = w.client();
    await c.hello();
    names = await c.toolNames();
  });
  after(async () => { await w.stop(); gl.close(); gh.close(); });

  test("a GitLab token the tracker rejects saves nothing", async (t) => {
    if (!names.includes("add_source")) return t.skip(`${BUILD} has no add_source yet`);
    const r = await c.call("add_source", addGitlab(gl));
    assert.ok(wasRefused(r), JSON.stringify(r));
    assert.equal(failureText(r), "internal error");
    assert.deepEqual(gl.state.log.map((l) => [l.url, l.auth]), [["/api/v4/projects/demo%2Ftracker", "Bearer not-the-token"]]);
    assert.deepEqual(savedSources(w), ["primary"]);
  });

  test("a GitHub token the tracker rejects saves nothing", async (t) => {
    if (!names.includes("add_source")) return t.skip(`${BUILD} has no add_source yet`);
    const r = await c.call("add_source", addGithub(gh));
    assert.ok(wasRefused(r), JSON.stringify(r));
    assert.equal(failureText(r), "internal error");
    assert.deepEqual(gh.state.log.map((l) => [l.url, l.auth, l.accept, l.version]), [["/user", "Bearer not-the-token", "application/vnd.github+json", "2022-11-28"]]);
    assert.deepEqual(savedSources(w), ["primary"]);
  });

  test("the tracker is not asked when the token variable is unset, and the caller is told which one", async (t) => {
    if (!names.includes("add_source")) return t.skip(`${BUILD} has no add_source yet`);
    gl.state.log.length = 0;
    gh.state.log.length = 0;
    const lab = await c.call("add_source", addGitlab(gl, { token: "${CONTRACT_UNSET_VAR}" }));
    assert.ok(wasRefused(lab), JSON.stringify(lab));
    unsetMessage(failureText(lab), `Token for GitLab source "${GITLAB_PROJECT}" references env var CONTRACT_UNSET_VAR which is not set. Set it in your environment or in <DATA_DIR>/.env: CONTRACT_UNSET_VAR=<your-token>${daemonRemedy("CONTRACT_UNSET_VAR")}`);
    const hub = await c.call("add_source", addGithub(gh, { token: "${CONTRACT_UNSET_VAR}" }));
    assert.ok(wasRefused(hub), JSON.stringify(hub));
    unsetMessage(failureText(hub), `Token for GitHub source "${GITHUB_PROJECT}" references env var CONTRACT_UNSET_VAR which is not set. Set it in your environment or in <DATA_DIR>/.env: CONTRACT_UNSET_VAR=<your-token>${daemonRemedy("CONTRACT_UNSET_VAR")}`);
    assert.equal(gl.state.log.length + gh.state.log.length, 0);
    assert.deepEqual(savedSources(w), ["primary"]);
  });
});

describe("add_source with a token the tracker accepts", () => {
  let gl, gh, w, c, names;
  before(async () => {
    gl = await fakeGitlab();
    seedGitlab(gl);
    gh = await fakeGithub();
    seedGithub(gh);
    w = await makeWorld({ serverEnv: { CONTRACT_GITLAB_TOKEN: GITLAB_TOKEN, CONTRACT_GITHUB_TOKEN: GITHUB_TOKEN } });
    c = w.client();
    await c.hello();
    names = await c.toolNames();
  });
  after(async () => { await w.stop(); gl.close(); gh.close(); });

  test("a GitLab source is saved and its first run queued", async (t) => {
    if (!names.includes("add_source")) return t.skip(`${BUILD} has no add_source yet`);
    const r = await c.call("add_source", addGitlab(gl, { source_id: "issues" }));
    assert.equal(r.isError, false, JSON.stringify(r));
    assert.equal(r.value.ok, true);
    assert.deepEqual([r.value.project_id, r.value.source_id], ["demo", "issues"]);
    assert.match(r.value.job_id, /^[0-9a-f]{8}$/);
    assert.equal(gl.state.log[0].url, "/api/v4/projects/demo%2Ftracker");
    assert.equal(gl.state.log[0].auth, `Bearer ${GITLAB_TOKEN}`);
    const saved = JSON.parse(readFileSync(join(w.data, "projects.json"), "utf8"))[0].sources.find((s) => s.source_id === "issues");
    assert.deepEqual(saved.source_config, { type: "ticket", provider: "gitlab", base_url: gl.url, project_id: GITLAB_PROJECT, token: "${CONTRACT_GITLAB_TOKEN}" });
    await until(hasIssue(c, "issues/4"), 60_000, "the first run to index the issues");
  });

  test("a GitHub source is saved and its first run queued", async (t) => {
    if (!names.includes("add_source")) return t.skip(`${BUILD} has no add_source yet`);
    const r = await c.call("add_source", addGithub(gh, { source_id: "hub-issues" }));
    assert.equal(r.isError, false, JSON.stringify(r));
    assert.equal(r.value.ok, true);
    assert.match(r.value.job_id, /^[0-9a-f]{8}$/);
    assert.equal(gh.state.log[0].url, "/user");
    assert.equal(gh.state.log[0].auth, `Bearer ${GITHUB_TOKEN}`);
    const saved = JSON.parse(readFileSync(join(w.data, "projects.json"), "utf8"))[0].sources.find((s) => s.source_id === "hub-issues");
    assert.deepEqual(saved.source_config, { type: "ticket", provider: "github", base_url: gh.url, project_id: GITHUB_PROJECT, token: "${CONTRACT_GITHUB_TOKEN}" });
  });

  test("a source id already in use is refused", async (t) => {
    if (!names.includes("add_source")) return t.skip(`${BUILD} has no add_source yet`);
    const r = await c.call("add_source", addGitlab(gl, { source_id: "issues" }));
    assert.ok(wasRefused(r), JSON.stringify(r));
    assert.deepEqual(savedSources(w).filter((s) => s === "issues"), ["issues"]);
  });
});

// ─── Projects, sources, branches and private ignore rules ────────────────────

const INTERNAL = "internal error";
const jobDone = (c, id) => until(async () => {
  const s = (await c.call("reindex_status", { job_id: id })).value;
  return ["done", "completed", "failed", "cancelled"].includes(s?.status) && s;
}, 90_000, "the job");
const registryOf = (w) => JSON.parse(readFileSync(join(w.data, "projects.json"), "utf8"));
const sourceOf = (w, project, source) => registryOf(w).find((p) => p.id === project)?.sources.find((s) => s.source_id === source);
const tagCount = (w, project, source) => {
  const db = new DatabaseSync(join(w.data, "branch-tags.db"), { readOnly: true });
  try {
    const sql = source === undefined ? "SELECT COUNT(*) AS n FROM branch_tags WHERE project_id=?" : "SELECT COUNT(*) AS n FROM branch_tags WHERE project_id=? AND source_id=?";
    return db.prepare(sql).get(...(source === undefined ? [project] : [project, source])).n;
  } finally {
    db.close();
  }
};
const filesStartingWith = (dir, prefix) => (existsSync(dir) ? readdirSync(dir).filter((f) => f.startsWith(prefix)) : []);
const refusedAs = (r, message) => {
  assert.ok(wasRefused(r), JSON.stringify(r));
  assert.equal(failureText(r), message);
};
const addCodeSource = async (c, w, project, source) => {
  const r = await c.call("add_source", { project_id: project, source_id: source, source_type: "code", root_path: w.repo });
  assert.equal(r.isError, false, JSON.stringify(r));
  const job = await jobDone(c, r.value.job_id);
  assert.equal(job.status, "done", JSON.stringify(job));
  return r.value.job_id;
};
const ISO_TIME = /^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{3}Z$/;

describe("projects, sources, branches and private ignore rules", () => {
  let w, c;
  before(async () => {
    w = await makeWorld();
    await w.index("--full");
    await w.index("--branch", "side");
    c = w.client();
    await c.hello();
    await c.rpc("tools/list");
  });
  after(() => w.stop());

  test("a project is added with or without a description, and a repeat is refused", async () => {
    const solo = await c.call("add_project", { project_id: "solo" });
    assert.deepEqual(solo.value, { ok: true, project_id: "solo" });
    assert.deepEqual(registryOf(w).find((p) => p.id === "solo"), { id: "solo", description: "", sources: [] });
    assert.deepEqual((await c.call("add_project", { project_id: "second", description: "two" })).value, { ok: true, project_id: "second" });
    refusedAs(await c.call("add_project", { project_id: "second", description: "other" }), INTERNAL);
    const second = registryOf(w).filter((p) => p.id === "second");
    assert.equal(second.length, 1);
    assert.equal(second[0].description, "two");
    const typo = await c.call("add_project", { project: "x" });
    assert.ok(wasRefused(typo), JSON.stringify(typo));
    assert.equal(failureText(typo), "invalid params for add_project: unknown key 'project' (did you mean 'project_id'?)");
    assert.ok(!registryOf(w).some((p) => p.id === "x"));
  });

  test("update_project returns the whole project, and only a description changes it", async () => {
    assert.deepEqual((await c.call("update_project", { project_id: "second", description: "changed" })).value, { id: "second", description: "changed", sources: [] });
    assert.equal(registryOf(w).find((p) => p.id === "second").description, "changed");
    assert.deepEqual((await c.call("update_project", { project_id: "second" })).value, { id: "second", description: "changed", sources: [] });
    const demo = (await c.call("update_project", { project_id: "demo" })).value;
    assert.equal(demo.id, "demo");
    assert.equal(demo.description, "A demo");
    assert.deepEqual(demo.sources.map((s) => s.source_id), ["primary"]);
    refusedAs(await c.call("update_project", { project_id: "nope", description: "x" }), INTERNAL);
    assert.ok(!registryOf(w).some((p) => p.id === "nope"));
  });

  test("an empty project is removed without touching the others", async () => {
    assert.deepEqual((await c.call("remove_project", { project_id: "solo" })).value, { ok: true, project_id: "solo" });
    const ids = registryOf(w).map((p) => p.id);
    assert.ok(!ids.includes("solo"));
    assert.ok(ids.includes("demo") && ids.includes("second"));
    refusedAs(await c.call("remove_project", { project_id: "solo" }), INTERNAL);
    assert.deepEqual((await c.call("remove_project", { project_id: "second" })).value, { ok: true, project_id: "second" });
  });

  test("list_branches names the indexed branches of each source, '*' for a tracker, nothing for an unknown source", async () => {
    const primary = (await c.call("list_branches", { project_id: "demo" })).value;
    assert.equal(primary.length, 1);
    assert.equal(primary[0].source_id, "primary");
    assert.deepEqual([...primary[0].branches].sort(), [w.main, "side"].sort());
    await addCodeSource(c, w, "demo", "extra");
    const both = (await c.call("list_branches", { project_id: "demo" })).value;
    assert.deepEqual(both.map((e) => e.source_id), ["primary", "extra"]);
    assert.deepEqual(both[1].branches, [w.main]);
    assert.deepEqual((await c.call("list_branches", { project_id: "demo", source_id: "extra" })).value, [{ source_id: "extra", branches: [w.main] }]);
    assert.deepEqual((await c.call("list_branches", { project_id: "demo", source_id: "nope" })).value, []);
    refusedAs(await c.call("list_branches", { project_id: "nope" }), INTERNAL);
    await c.call("remove_source", { project_id: "demo", source_id: "extra" });
  });

  test("private ignore rules are written, read, listed, left alone when unchanged, and cleared", async () => {
    const path = join(w.data, "ignores", "demo", "primary.gitignore");
    assert.deepEqual((await c.call("get_private_ignore", { project_id: "demo", source_id: "primary" })).value, { project_id: "demo", source_id: "primary", content: null, path, rule_count: 0 });
    assert.deepEqual((await c.call("list_private_ignores")).value, []);
    const rules = "# mine\nsecret/\n*.tmp\n";
    const set = await c.call("set_private_ignore", { project_id: "demo", source_id: "primary", content: rules });
    assert.deepEqual(set.value, {
      ok: true,
      path,
      action: "written",
      hint: "To apply changes, run: scrybe index -P demo -S primary --incremental\n  (or via MCP: reindex_source with project_id=\"demo\", source_id=\"primary\", mode=\"incremental\")",
    });
    assert.equal(readFileSync(path, "utf8"), rules);
    assert.deepEqual((await c.call("get_private_ignore", { project_id: "demo", source_id: "primary" })).value, { project_id: "demo", source_id: "primary", content: rules, path, rule_count: 2 });
    for (const args of [{}, { project_id: "demo" }]) {
      const listed = (await c.call("list_private_ignores", args)).value;
      assert.equal(listed.length, 1, JSON.stringify(listed));
      assert.deepEqual({ ...listed[0], mtime: undefined }, { project_id: "demo", source_id: "primary", path, rule_count: 2, mtime: undefined });
      assert.match(listed[0].mtime, ISO_TIME);
    }
    assert.equal((await c.call("set_private_ignore", { project_id: "demo", source_id: "primary", content: rules })).value.action, "unchanged");
    assert.equal((await c.call("set_private_ignore", { project_id: "demo", source_id: "primary", content: "secret/\n" })).value.action, "written");
    assert.equal(readFileSync(path, "utf8"), "secret/\n");
    assert.equal((await c.call("set_private_ignore", { project_id: "demo", source_id: "primary", content: "# only a note\n" })).value.action, "deleted");
    assert.ok(!existsSync(path));
    assert.equal((await c.call("get_private_ignore", { project_id: "demo", source_id: "primary" })).value.content, null);
    assert.deepEqual((await c.call("list_private_ignores")).value, []);
    assert.equal((await c.call("set_private_ignore", { project_id: "demo", source_id: "primary", content: "" })).value.action, "unchanged");
    assert.equal((await c.call("set_private_ignore", { project_id: "demo", source_id: "primary", content: "# only a note\n" })).value.action, "unchanged");
    assert.ok(!existsSync(path), "a note alone is not written");
    await c.call("set_private_ignore", { project_id: "demo", source_id: "primary", content: "x\n" });
    assert.equal((await c.call("set_private_ignore", { project_id: "demo", source_id: "primary", content: "" })).value.action, "deleted");
    assert.ok(!existsSync(path));
  });

  test("private ignore tools refuse an unknown project or source and write nothing", async () => {
    for (const [tool, args] of [
      ["set_private_ignore", { project_id: "nope", source_id: "primary", content: "x\n" }],
      ["set_private_ignore", { project_id: "demo", source_id: "nope", content: "x\n" }],
      ["get_private_ignore", { project_id: "nope", source_id: "primary" }],
      ["get_private_ignore", { project_id: "demo", source_id: "nope" }],
      ["list_private_ignores", { project_id: "nope" }],
    ]) refusedAs(await c.call(tool, args), INTERNAL);
    assert.ok(!existsSync(join(w.data, "ignores", "nope")));
    assert.ok(!existsSync(join(w.data, "ignores", "demo", "nope.gitignore")));
    assert.equal((await c.call("get_private_ignore", { project_id: "demo", source_id: "primary" })).isError, false);
  });

  test("a rule set through the tool keeps a file out of the next full index run, and clearing it brings the file back", async () => {
    const found = async () => (await c.call("lookup_symbol", { project_id: "demo", symbol_name: "calibrate_gadget" })).value.length;
    // An incremental run leaves rows of an already indexed file in place, so the check uses a full one.
    const reindex = async () => {
      const r = await c.call("reindex_source", { project_id: "demo", source_id: "primary", mode: "full" });
      assert.equal((await jobDone(c, r.value.job_id)).status, "done");
    };
    assert.equal(await found(), 1);
    await c.call("set_private_ignore", { project_id: "demo", source_id: "primary", content: "src/gadget.py\n" });
    await reindex();
    assert.equal(await found(), 0);
    await c.call("set_private_ignore", { project_id: "demo", source_id: "primary", content: "" });
    await reindex();
    assert.equal(await found(), 1);
  });

  test("remove_source takes the source's rows, hash files, cursor and table, and nothing of its neighbour", async () => {
    await addCodeSource(c, w, "demo", "extra");
    const extra = sourceOf(w, "demo", "extra");
    const primary = sourceOf(w, "demo", "primary");
    const lance = (s) => join(w.data, "lancedb", `${s.table_name}.lance`);
    const sidecar = (s) => join(w.data, "lancedb", `${s.table_name}-meta.json`);
    const cursor = (id) => join(w.data, "cursors", `demo__${id}.json`);
    assert.ok(extra.table_name && extra.table_name !== primary.table_name);
    assert.ok(tagCount(w, "demo", "extra") > 0);
    assert.ok(filesStartingWith(join(w.data, "hashes"), "demo__extra__").length > 0);
    assert.ok(existsSync(lance(extra)) && existsSync(sidecar(extra)) && existsSync(cursor("extra")));

    refusedAs(await c.call("remove_source", { project_id: "demo", source_id: "nope" }), INTERNAL);
    refusedAs(await c.call("remove_source", { project_id: "nope", source_id: "extra" }), INTERNAL);
    assert.deepEqual(registryOf(w)[0].sources.map((s) => s.source_id), ["primary", "extra"]);
    assert.ok(tagCount(w, "demo", "extra") > 0);

    assert.deepEqual((await c.call("remove_source", { project_id: "demo", source_id: "extra" })).value, { ok: true, project_id: "demo", source_id: "extra" });
    assert.deepEqual(registryOf(w)[0].sources.map((s) => s.source_id), ["primary"]);
    assert.equal(tagCount(w, "demo", "extra"), 0);
    assert.deepEqual(filesStartingWith(join(w.data, "hashes"), "demo__extra__"), []);
    assert.ok(!existsSync(lance(extra)) && !existsSync(sidecar(extra)) && !existsSync(cursor("extra")));
    assert.ok(tagCount(w, "demo", "primary") > 0);
    assert.ok(filesStartingWith(join(w.data, "hashes"), "demo__primary__").length > 0);
    assert.ok(existsSync(lance(primary)) && existsSync(sidecar(primary)) && existsSync(cursor("primary")));
    const search = await c.call("search_code", { project_id: "demo", query: "frobnicateWidget", top_k: 5 });
    assert.ok(search.value.length > 0 && search.value.every((h) => h.source_id === "primary"), JSON.stringify(search.value));
  });

  test("remove_project takes every row of the project, announces it, and leaves its jobs and private rules", async () => {
    assert.equal((await c.call("add_project", { project_id: "doomed", description: "to go" })).value.ok, true);
    const jobId = await addCodeSource(c, w, "doomed", "code");
    const table = sourceOf(w, "doomed", "code").table_name;
    const lance = join(w.data, "lancedb", `${table}.lance`);
    await c.call("set_private_ignore", { project_id: "doomed", source_id: "code", content: "vendor/\n" });
    const before = await c.call("search_code", { project_id: "doomed", query: "frobnicateWidget", top_k: 5 });
    assert.ok(before.value.length > 0, JSON.stringify(before));
    assert.ok(tagCount(w, "doomed") > 0);
    assert.ok(filesStartingWith(join(w.data, "hashes"), "doomed__code__").length > 0);
    assert.ok(existsSync(lance) && existsSync(join(w.data, "cursors", "doomed__code.json")));
    const feed = await watchEvents(`http://127.0.0.1:${w.pidfile().port}`);
    try {
      refusedAs(await c.call("remove_project", { project_id: "nope" }), INTERNAL);
      assert.ok(registryOf(w).some((p) => p.id === "doomed"));
      assert.ok(tagCount(w, "doomed") > 0);

      assert.deepEqual((await c.call("remove_project", { project_id: "doomed" })).value, { ok: true, project_id: "doomed" });
      assert.ok(!registryOf(w).some((p) => p.id === "doomed"));
      assert.equal(tagCount(w, "doomed"), 0);
      assert.deepEqual(filesStartingWith(join(w.data, "hashes"), "doomed__"), []);
      assert.ok(!existsSync(lance) && !existsSync(join(w.data, "lancedb", `${table}-meta.json`)) && !existsSync(join(w.data, "cursors", "doomed__code.json")));
      assert.match(failureText(await c.call("search_code", { project_id: "doomed", query: "frobnicateWidget" })), /Project 'doomed' not found/);
      const event = await until(() => feed.events.find((e) => e.event === "project.removed" && e.projectId === "doomed"), 10_000, "the project.removed event");
      assert.equal(event.projectId, "doomed");
      assert.equal(event.level, "info");
      assert.deepEqual(event.detail, { jobsCancelled: 0 });
    } finally {
      feed.stop();
    }
    const others = await c.call("search_code", { project_id: "demo", query: "frobnicateWidget", top_k: 5 });
    assert.ok(others.value.length > 0, "another project is untouched");
    assert.ok(tagCount(w, "demo", "primary") > 0);
    // Today's build keeps the removed project's finished jobs and its private ignore file.
    assert.ok((await c.call("list_jobs")).value.jobs.some((j) => j.job_id === jobId));
    assert.equal(readFileSync(join(w.data, "ignores", "doomed", "code.gitignore"), "utf8"), "vendor/\n");
  });
});

describe("updating and inspecting a tracker source", () => {
  let gl, w, c;
  before(async () => {
    gl = await fakeGitlab();
    seedGitlab(gl);
    w = await makeWorld({ serverEnv: { CONTRACT_GITLAB_TOKEN: GITLAB_TOKEN } });
    c = w.client();
    await c.hello();
    await c.rpc("tools/list");
    const r = await c.call("add_source", addGitlab(gl, { source_id: "issues" }));
    assert.equal(r.isError, false, JSON.stringify(r));
    assert.equal((await jobDone(c, r.value.job_id)).status, "done");
  });
  after(async () => { await w.stop(); gl.close(); });

  const config = () => sourceOf(w, "demo", "issues").source_config;
  const update = (args) => c.call("update_source", { project_id: "demo", source_id: "issues", ...args });

  test("update_source changes only the fields given, and says whether anything changed", async () => {
    const original = { type: "ticket", provider: "gitlab", base_url: gl.url, project_id: GITLAB_PROJECT, token: "${CONTRACT_GITLAB_TOKEN}" };
    assert.deepEqual(config(), original);
    assert.deepEqual((await update({})).value, { ok: true, project_id: "demo", source_id: "issues", updated: false });
    assert.deepEqual(config(), original);
    assert.deepEqual((await update({ token: "" })).value.updated, false);
    const r = await update({ project: "demo/renamed", token: "${CONTRACT_OTHER_TOKEN}" });
    assert.deepEqual(r.value, { ok: true, project_id: "demo", source_id: "issues", updated: true });
    assert.deepEqual(config(), { ...original, project_id: "demo/renamed", token: "${CONTRACT_OTHER_TOKEN}" });
    assert.deepEqual((await update({ url: "http://tracker.example.invalid" })).value.updated, true);
    assert.deepEqual(config(), { ...original, base_url: "http://tracker.example.invalid", project_id: "demo/renamed", token: "${CONTRACT_OTHER_TOKEN}" });
  });

  test("the old gitlab_ names still work, and the new name wins when both are given", async () => {
    assert.equal((await update({ gitlab_token: "${CONTRACT_OLD_NAME}" })).value.updated, true);
    assert.equal(config().token, "${CONTRACT_OLD_NAME}");
    assert.equal((await update({ token: "${CONTRACT_NEW_NAME}", gitlab_token: "${CONTRACT_OLD_NAME}" })).value.updated, true);
    assert.equal(config().token, "${CONTRACT_NEW_NAME}");
    assert.equal((await update({ gitlab_project_id: "demo/legacy", gitlab_url: gl.url })).value.updated, true);
    assert.deepEqual([config().project_id, config().base_url], ["demo/legacy", gl.url]);
  });

  test("update_source ignores fields that belong to the other kind of source, and refuses unknown names", async () => {
    const before = JSON.stringify(registryOf(w));
    assert.equal((await update({ root_path: "/somewhere" })).value.updated, false);
    assert.equal(JSON.stringify(registryOf(w)), before);
    refusedAs(await c.call("update_source", { project_id: "demo", source_id: "nope", token: "x" }), INTERNAL);
    refusedAs(await c.call("update_source", { project_id: "nope", source_id: "issues", token: "x" }), INTERNAL);
    const typo = await update({ rootpath: "/x" });
    assert.ok(wasRefused(typo), JSON.stringify(typo));
    assert.equal(failureText(typo), "invalid params for update_source: unknown key 'rootpath' (did you mean 'root_path'?)");
    assert.equal(JSON.stringify(registryOf(w)), before);
  });

  test("update_source changes a code source's root, and refuses a language list as today's build does", async () => {
    const original = sourceOf(w, "demo", "primary").source_config;
    const code = (args) => c.call("update_source", { project_id: "demo", source_id: "primary", ...args });
    assert.equal((await code({ root_path: "" })).value.updated, false);
    assert.equal((await code({ url: "http://x.invalid", token: "t" })).value.updated, false);
    assert.deepEqual(sourceOf(w, "demo", "primary").source_config, original);
    // The tool's schema asks for a list and its code splits a string, so a language hint can't be given.
    refusedAs(await code({ languages: ["ts"] }), INTERNAL);
    refusedAs(await code({ languages: [] }), INTERNAL);
    assert.deepEqual(sourceOf(w, "demo", "primary").source_config, original);
    assert.deepEqual((await code({ root_path: "/elsewhere" })).value, { ok: true, project_id: "demo", source_id: "primary", updated: true });
    assert.deepEqual(sourceOf(w, "demo", "primary").source_config, { ...original, root_path: "/elsewhere" });
  });

  test("a tracker source lists '*' as its branch and has no private ignore rules to set", async () => {
    const listed = (await c.call("list_branches", { project_id: "demo" })).value;
    assert.deepEqual(listed, [{ source_id: "primary", branches: [] }, { source_id: "issues", branches: ["*"] }]);
    const path = join(w.data, "ignores", "demo", "issues.gitignore");
    refusedAs(await c.call("set_private_ignore", { project_id: "demo", source_id: "issues", content: "x\n" }), INTERNAL);
    assert.ok(!existsSync(path));
    assert.deepEqual((await c.call("get_private_ignore", { project_id: "demo", source_id: "issues" })).value, { project_id: "demo", source_id: "issues", content: null, path, rule_count: 0 });
    assert.equal((await c.call("set_private_ignore", { project_id: "demo", source_id: "primary", content: "x\n" })).value.action, "written");
    assert.deepEqual((await c.call("list_private_ignores")).value.map((e) => e.source_id), ["primary"]);
  });
});

const hashFileOf = (w, label) => join(w.data, "hashes", `demo__primary__${label.replace(/\//g, "__")}.json`);
const labelRows = (w, label) => {
  const db = new DatabaseSync(join(w.data, "branch-tags.db"), { readOnly: true });
  try {
    return db.prepare("SELECT COUNT(*) AS n FROM branch_tags WHERE project_id='demo' AND source_id='primary' AND branch=?").get(label).n;
  } finally {
    db.close();
  }
};

describe("ephemeral labels", () => {
  let w, c, names;
  const label = "_ephemeral/mr-side";
  const find = async (symbol, branch) => (await c.call("lookup_symbol", { project_id: "demo", symbol_name: symbol, branch })).value;
  before(async () => {
    w = await makeWorld({ withOrigin: true });
    await w.index("--full");
    c = w.client();
    await c.hello();
    names = await c.toolNames();
  });
  after(() => w.stop());
  const ported = (t) => {
    if (names.includes("index_ephemeral") && names.includes("drop_ephemeral")) return true;
    t.skip(`${BUILD} has no index_ephemeral yet`);
    return false;
  };

  test("a fetched branch becomes searchable under its own label and nowhere else", async (t) => {
    if (!ported(t)) return;
    assert.equal((await find("onlyOnTheSideBranch", label)).length, 0, "nothing before it is indexed");
    const r = await c.call("index_ephemeral", { project_id: "demo", branch: "side" });
    assert.ok(!r.isError && !r.rpcError, JSON.stringify(r));
    assert.equal(r.value.label, label);
    assert.equal(typeof r.value.chunks_new, "number");
    assert.equal(typeof r.value.chunks_reused, "number");
    assert.ok(r.value.duration_ms >= 0);
    assert.equal((await find("onlyOnTheSideBranch", label)).length, 1);
    assert.equal((await find("onlyOnTheSideBranch", w.main)).length, 0, "the checked-out branch does not see it");
    assert.equal((await find("frobnicateWidget", label)).length, 1, "the label holds the whole branch");
    const search = await c.call("search_code", { project_id: "demo", query: "onlyOnTheSideBranch", branch: label, top_k: 3 });
    assert.equal(search.value[0].item_path, "src/side_only.ts");
    assert.ok(labelRows(w, label) > 0);
    assert.ok(existsSync(hashFileOf(w, label)));
    const listed = (await c.call("list_branches", { project_id: "demo", source_id: "primary" })).value;
    assert.ok(listed[0].branches.includes(label), JSON.stringify(listed));
    assert.ok(!(await c.call("list_pinned_branches", { project_id: "demo" })).text.includes("_ephemeral"), "it is never pinned");
  });

  test("the label can be chosen, and a full ref is read as given", async (t) => {
    if (!ported(t)) return;
    const r = await c.call("index_ephemeral", { project_id: "demo", branch: "refs/heads/side", label: "review-1" });
    assert.equal(r.value?.label, "_ephemeral/review-1", JSON.stringify(r));
    assert.equal((await find("onlyOnTheSideBranch", "_ephemeral/review-1")).length, 1);
    const again = await c.call("index_ephemeral", { project_id: "demo", branch: "origin/side" });
    assert.equal(again.value?.label, label, "the label comes from the last segment of a full ref");
    assert.equal((await c.call("drop_ephemeral", { project_id: "demo", label: "_ephemeral/review-1" })).value.dropped, true);
  });

  test("an unknown project, source or ref is refused and leaves no label", async (t) => {
    if (!ported(t)) return;
    refusedAs(await c.call("index_ephemeral", { project_id: "nope", branch: "side" }), INTERNAL);
    refusedAs(await c.call("index_ephemeral", { project_id: "demo", branch: "side", source_id: "nope" }), INTERNAL);
    refusedAs(await c.call("index_ephemeral", { project_id: "demo", branch: "no-such-branch" }), INTERNAL);
    assert.equal(labelRows(w, "_ephemeral/mr-no-such-branch"), 0);
    assert.ok(wasRefused(await c.call("index_ephemeral", { project_id: "demo" })), "branch is required");
    assert.ok(!(await c.call("index_ephemeral", { project_id: "demo", branch: "side" })).isError, "the same call with a real branch works");
  });

  test("a label outside the prefix is never dropped", async (t) => {
    if (!ported(t)) return;
    const before = tagCount(w, "demo", "primary");
    refusedAs(await c.call("drop_ephemeral", { project_id: "demo", label: w.main }), INTERNAL);
    refusedAs(await c.call("drop_ephemeral", { project_id: "demo", label: "ephemeral/mr-side" }), INTERNAL);
    refusedAs(await c.call("drop_ephemeral", { project_id: "nope", label }), INTERNAL);
    assert.equal(tagCount(w, "demo", "primary"), before);
    assert.equal((await find("frobnicateWidget", w.main)).length, 1);
  });

  test("dropping a label removes its rows and state, and keeps what the branch checked out still uses", async (t) => {
    if (!ported(t)) return;
    assert.ok(labelRows(w, label) > 0);
    const r = await c.call("drop_ephemeral", { project_id: "demo", label });
    assert.ok(!r.isError && !r.rpcError, JSON.stringify(r));
    assert.equal(r.value.label, label);
    assert.equal(r.value.dropped, true);
    assert.ok(r.value.orphans_deleted > 0, "rows only this label used are reclaimed");
    assert.equal(typeof r.value.bytes_freed, "number");
    assert.equal(labelRows(w, label), 0);
    assert.ok(!existsSync(hashFileOf(w, label)));
    assert.equal((await find("onlyOnTheSideBranch", label)).length, 0);
    assert.equal((await find("frobnicateWidget", w.main)).length, 1, "committed rows stay");
    assert.equal((await find("calibrate_gadget", w.main)).length, 1);
    const again = await c.call("drop_ephemeral", { project_id: "demo", label });
    assert.equal(again.value?.dropped, false, JSON.stringify(again));
    assert.equal(again.value.orphans_deleted, 0);
  });
});

const cfgOf = (w) => JSON.parse(readFileSync(join(w.data, "config.json"), "utf8"));
const cfgText = (w) => readFileSync(join(w.data, "config.json"), "utf8");

describe("embedding presets", () => {
  let w, c, names, extra;
  before(async () => {
    w = await makeWorld();
    extra = { ...cfgOf(w), zeta: { kept: true }, reranker_presets: { r1: { model: "rerank-2" } } };
    writeFileSync(join(w.data, "config.json"), JSON.stringify(extra, null, 2));
    c = w.client();
    await c.hello();
    names = await c.toolNames();
  });
  after(() => w.stop());
  const ported = (t) => {
    if (names.includes("add_embedding_preset") && names.includes("assign_preset")) return true;
    t.skip(`${BUILD} has no preset tools yet`);
    return false;
  };
  const add = async (args) => (await c.call("add_embedding_preset", args)).value;
  const assign = async (slot, preset_name) => (await c.call("assign_preset", { slot, preset_name })).value;
  const other = () => ({ name: "other", provider: "custom", model: "other-model", dim: 8, base_url: w.fake.url, credentials: "${CONTRACT_EMBED_KEY}" });

  test("a preset is stored beside what was already there, and a duplicate is refused", async (t) => {
    if (!ported(t)) return;
    assert.deepEqual(await add(other()), { ok: true, preset_name: "other" });
    const cfg = cfgOf(w);
    assert.deepEqual(cfg.embedding_presets.other, { provider: "custom", model: "other-model", credentials: "${CONTRACT_EMBED_KEY}", base_url: w.fake.url, dim: 8 });
    assert.deepEqual(cfg.embedding_presets.fake, extra.embedding_presets.fake);
    assert.deepEqual(cfg.zeta, { kept: true });
    assert.deepEqual(cfg.assignments, extra.assignments);
    const saved = cfgText(w);
    assert.ok(saved.endsWith("}\n"));
    const dup = await add({ ...other(), model: "changed" });
    assert.equal(dup.ok, false);
    assert.equal(dup.preset_name, "other");
    assert.match(dup.error, /Preset 'other' already exists/);
    assert.equal(cfgText(w), saved);
  });

  test("a preset with a missing or misplaced field is refused and nothing is saved", async (t) => {
    if (!ported(t)) return;
    const saved = cfgText(w);
    const refused = async (args, pattern) => {
      const r = await add(args);
      assert.equal(r.ok, false, JSON.stringify(r));
      assert.match(r.error, pattern);
      assert.equal(cfgText(w), saved);
    };
    await refused({ name: "a", provider: "custom", model: "m", dim: 8 }, /base-url is required/);
    await refused({ name: "a", provider: "custom", model: "m", base_url: "http://x/v1" }, /dim is required/);
    await refused({ name: "a", provider: "nope", model: "m" }, /Unknown provider: "nope"/);
    await refused({ name: "a", provider: "local", model: "no-such-model" }, /Model "no-such-model" not found in provider "local"/);
    await refused({ name: "a", provider: "local", model: "Xenova/all-MiniLM-L6-v2", base_url: "http://x/v1" }, /base-url is only valid for custom/);
    await refused({ name: "a", provider: "local", model: "Xenova/all-MiniLM-L6-v2", dim: 8 }, /dim is only valid for custom/);
    await refused({ name: "a", provider: "local", model: "Xenova/all-MiniLM-L6-v2", encoding_format: "float" }, /encoding-format is only valid for custom/);
    assert.deepEqual(await add({ name: "a", provider: "local", model: "Xenova/all-MiniLM-L6-v2" }), { ok: true, preset_name: "a" });
    assert.deepEqual(cfgOf(w).embedding_presets.a, { provider: "local", model: "Xenova/all-MiniLM-L6-v2" });
    assert.deepEqual(await add({ name: "f", provider: "custom", model: "m", dim: 8, base_url: "http://x/v1", encoding_format: "float", credentials_from: "other" }), { ok: true, preset_name: "f" });
    assert.deepEqual(cfgOf(w).embedding_presets.f, { provider: "custom", model: "m", credentials_from: "other", base_url: "http://x/v1", dim: 8, encoding_format: "float" });
  });

  test("an assignment says whether the vectors on disk must be rebuilt, and changes what status reports", async (t) => {
    if (!ported(t)) return;
    assert.equal((await c.call("status")).value.code_model, "fake-model");
    assert.deepEqual(await assign("code", "fake"), { ok: true, requires_reindex: false });
    assert.deepEqual(await assign("code", "other"), { ok: true, requires_reindex: true });
    assert.equal(cfgOf(w).assignments.code_preset, "other");
    assert.equal(cfgOf(w).assignments.text_preset, "fake");
    assert.equal((await c.call("status")).value.code_model, "other-model");
    assert.deepEqual(await assign("code", "other"), { ok: true, requires_reindex: false });
    assert.deepEqual(await assign("code", "fake"), { ok: true, requires_reindex: true });
    assert.equal((await c.call("status")).value.code_model, "fake-model");
    assert.deepEqual(cfgOf(w).zeta, { kept: true });
  });

  test("an assignment to a missing preset, the wrong profile or an unset credential changes nothing", async (t) => {
    if (!ported(t)) return;
    await add({ name: "wants-key", provider: "custom", model: "m", dim: 8, base_url: "http://x/v1", credentials: "${CONTRACT_NOT_SET_ANYWHERE}" });
    await add({ name: "v4", provider: "voyage", model: "voyage-4", credentials: "literal" });
    const saved = cfgText(w);
    const refused = async (slot, name, pattern) => {
      const r = await assign(slot, name);
      assert.equal(r.ok, false, JSON.stringify(r));
      assert.equal(r.requires_reindex, false);
      assert.match(r.error, pattern);
      assert.equal(cfgText(w), saved);
    };
    await refused("code", "nope", /Preset 'nope' not found in embedding_presets\./);
    await refused("text", "nope", /Preset 'nope' not found in embedding_presets\./);
    await refused("rerank", "nope", /Reranker preset 'nope' not found in reranker_presets\./);
    await refused("code", "v4", /preset "v4" uses model "voyage-4" with profile "text", but it is assigned to slot "code_preset" which requires profile "code"/);
    await refused("code", "wants-key", /env var CONTRACT_NOT_SET_ANYWHERE not set \(referenced in scrybe config\)/);
    assert.deepEqual(await assign("text", "v4"), { ok: true, requires_reindex: true });
    assert.equal((await c.call("status")).value.text_model, "voyage-4");
    assert.deepEqual(await assign("text", "fake"), { ok: true, requires_reindex: true });
  });

  test("the rerank slot takes a reranker preset or 'none'", async (t) => {
    if (!ported(t)) return;
    assert.deepEqual(await assign("rerank", "r1"), { ok: true, requires_reindex: false });
    assert.equal(cfgOf(w).assignments.rerank_preset, "r1");
    assert.deepEqual(await assign("rerank", "none"), { ok: true, requires_reindex: false });
    assert.ok(!("rerank_preset" in cfgOf(w).assignments));
    assert.deepEqual(cfgOf(w).reranker_presets, { r1: { model: "rerank-2" } });
  });

  test("a slot or argument the schema doesn't know is a clean error", async (t) => {
    if (!ported(t)) return;
    const saved = cfgText(w);
    for (const args of [{ slot: "both", preset_name: "fake" }, { slot: "code" }, { slot: "code", preset_name: "fake", extra: 1 }]) {
      assert.ok(wasRefused(await c.call("assign_preset", args)), JSON.stringify(args));
    }
    assert.ok(wasRefused(await c.call("add_embedding_preset", { name: "x", provider: "custom" })));
    assert.equal(cfgText(w), saved);
  });
});

describe("progress while an index runs", () => {
  let w, c, fake;
  before(async () => {
    // One chunk per request and a slow endpoint, so a job is still embedding when it is looked at.
    fake = await fakeEmbedder({ delayMs: 150 });
    w = await makeWorld({ embedder: fake, serverEnv: { SCRYBE_EMBED_BATCH_SIZE: "1" } });
    c = w.client();
    await c.hello();
  });
  after(async () => { await w.stop(); fake.close(); });

  test("a job moves from scanning to embedding with live counts, and ends without a percent", async () => {
    const id = (await c.call("reindex_source", { project_id: "demo", source_id: "primary", mode: "full" })).value.job_id;
    const seen = [];
    const stored = new Set();
    const done = await until(async () => {
      const s = (await c.call("reindex_status", { job_id: id })).value;
      if (s?.status === "running" && s.tasks[0]) seen.push({ ...s.tasks[0] });
      const pf = w.pidfile();
      if (pf && s?.status === "running") {
        const row = await (await fetch(`http://127.0.0.1:${pf.port}/jobs/${id}`)).json().catch(() => null);
        if (row?.phase) stored.add(row.phase);
      }
      await sleep(40);
      return ["done", "failed"].includes(s?.status) && s;
    }, 60_000, "the job");
    assert.equal(done.status, "done", JSON.stringify(done));
    const embedding = seen.filter((t) => t.phase === "embedding");
    assert.ok(embedding.length >= 2, `phases seen: ${seen.map((t) => t.phase).join(",")}`);
    const counts = embedding.map((t) => t.chunks_prepared);
    assert.ok(counts[0] > 0, `first embedding count ${counts[0]}`);
    for (let i = 1; i < counts.length; i++) assert.ok(counts[i] >= counts[i - 1], `counts went down: ${counts}`);
    assert.ok(counts.at(-1) <= done.tasks[0].chunks_prepared);
    assert.ok(embedding.every((t) => t.files_scanned === done.tasks[0].files_scanned && t.percent == null), JSON.stringify(embedding[0]));
    assert.ok(seen.every((t) => ["scanning", "embedding"].includes(t.phase)), `phases seen: ${[...new Set(seen.map((t) => t.phase))]}`);
    assert.ok(stored.has("embedding"), `stored phases: ${[...stored]}`);
    assert.equal(done.tasks[0].phase, "done");
    assert.equal(done.tasks[0].percent, undefined, JSON.stringify(done.tasks[0]));
  });
});

describe("progress on the command line", () => {
  let w;
  before(async () => { w = await makeWorld(); });
  after(() => w.stop());

  test("an in-process index rewrites one progress line per source", async () => {
    const r = await w.index("--full");
    const files = r.stdout.match(/\[primary\] Scanning\.\.\. (\d+) files/g) ?? [];
    assert.ok(files.length > 0, r.stdout);
    const scanned = files.map((m) => Number(m.match(/(\d+) files/)[1]));
    assert.deepEqual(scanned, scanned.map((_, i) => i + 1));
    const embedded = (r.stdout.match(/\[primary\] Embedding\.\.\. (\d+) chunks/g) ?? []).map((m) => Number(m.match(/(\d+) chunks/)[1]));
    const total = Number(r.stdout.match(/\[primary\] Done: (\d+) chunks indexed/)[1]);
    assert.ok(embedded.length >= 1, r.stdout);
    assert.equal(embedded.at(-1), total);
    assert.ok(r.stdout.includes("\r  [primary] Scanning... 1 files"), JSON.stringify(r.stdout.slice(0, 200)));
  });
});

describe("first-use model download from a stand-in host", () => {
  // Today's build always fetches from the real host, so only a build that can be pointed elsewhere runs these.
  const skip = BUILD === "ts" ? { skip: "today's build can't point the download elsewhere" } : {};
  let w, host, c;
  const modelDir = () => join(w.data, "models", LOCAL_MODEL);
  const follow = async (id) => {
    const seen = [];
    const done = await until(async () => {
      const s = (await c.call("reindex_status", { job_id: id })).value;
      if (s?.status === "running" && s.tasks[0]) seen.push({ ...s.tasks[0] });
      await sleep(30);
      return ["done", "failed"].includes(s?.status) && s;
    }, 60_000, "the job");
    return { seen, done };
  };
  before(async () => {
    if (BUILD === "ts") return;
    host = await fakeModelHost({ dropFirst: true });
    w = await makeWorld({ serverEnv: { SCRYBE_MODEL_REMOTE_HOST: host.url, SCRYBE_MODEL_CACHE_DIR: "" } });
    useLocalModel(w);
    c = w.client();
    await c.hello();
  });
  after(async () => { if (w) { await w.stop(); host.close(); } });

  test("a download cut off halfway fails the job and leaves nothing that looks finished", skip, async () => {
    const id = (await c.call("reindex_source", { project_id: "demo", source_id: "primary", mode: "full" })).value.job_id;
    const { done } = await follow(id);
    assert.equal(done.status, "failed", JSON.stringify(done));
    assert.match(done.tasks[0].error, /^Model not cached and no network available\. Run once with internet access to download the model \(~120 MB\): /);
    assert.ok(!existsSync(join(modelDir(), "config.json")));
    assert.ok(!existsSync(join(modelDir(), "onnx/model_quantized.onnx")));
  });

  test("the next run fetches every file, reports a rising percent, then fails on the stand-in weights", skip, async () => {
    const id = (await c.call("reindex_source", { project_id: "demo", source_id: "primary", mode: "full" })).value.job_id;
    const { seen, done } = await follow(id);
    assert.equal(done.status, "failed", JSON.stringify(done));
    assert.match(done.tasks[0].error, /^Local embedder failed to load: /);
    const percents = seen.filter((t) => t.phase === "downloading-model").map((t) => t.percent);
    assert.ok(percents.length >= 2, `phases seen: ${seen.map((t) => t.phase)}`);
    for (let i = 1; i < percents.length; i++) assert.ok(percents[i] >= percents[i - 1], `percent went down: ${percents}`);
    assert.ok(percents.every((p) => Number.isInteger(p) && p >= 0 && p <= 99), `${percents}`);
    for (const [file, body] of Object.entries(host.files)) assert.ok(readFileSync(join(modelDir(), file)).equals(body), `${file} differs`);
    // config.json, the file whose presence means "cached", is fetched last.
    assert.equal(host.log.filter((f) => f.endsWith(".json") || f.endsWith(".onnx")).at(-1), "config.json");
    assert.ok(host.agents.every((a) => a), `user agents: ${host.agents}`);
  });
});

describe("first-use model download, two at once and one cut short", () => {
  const skip = BUILD === "ts" ? { skip: "today's build can't point the download elsewhere" } : {};
  let w, host;
  const modelDir = () => join(w.data, "models", LOCAL_MODEL);
  const intact = () => {
    for (const [file, body] of Object.entries(host.files)) assert.ok(readFileSync(join(modelDir(), file)).equals(body), `${file} differs`);
  };
  beforeEach(async () => {
    if (BUILD === "ts") return;
    // Slow enough that the 3 MB weights take several seconds, so the two runs overlap.
    host = await fakeModelHost({ pieceDelayMs: 150 });
    w = await makeWorld({ serverEnv: { SCRYBE_MODEL_REMOTE_HOST: host.url, SCRYBE_MODEL_CACHE_DIR: "" } });
    useLocalModel(w);
  });
  afterEach(async () => { if (w) { await w.stop(); host.close(); } });

  test("two processes downloading at once end with one intact copy, fetched once", skip, async () => {
    const [a, b] = await Promise.all([w.cli("index", "-P", "demo", "-S", "primary", "--full"), (async () => { await sleep(300); return w.cli("index", "-P", "demo", "-S", "primary", "--full"); })()]);
    // Both get as far as loading the stand-in weights, whose empty tokenizer is the only failure.
    for (const r of [a, b]) assert.match(r.stderr + r.stdout, /Local embedder failed to load: tokenizer: /, `${r.status}: ${r.stderr}${r.stdout}`);
    intact();
    assert.equal(host.log.filter((f) => f.endsWith(".onnx")).length, 1, host.log.join(","));
  });

  test("a server stopped mid-download leaves nothing that looks cached, and the next run fetches it whole", skip, async () => {
    const c = w.client();
    await c.hello();
    const id = (await c.call("reindex_source", { project_id: "demo", source_id: "primary", mode: "full" })).value.job_id;
    await until(async () => {
      const s = (await c.call("reindex_status", { job_id: id })).value;
      return s?.tasks?.[0]?.phase === "downloading-model" && s.tasks[0].percent > 0;
    }, 30_000, "the download to start");
    await w.killServer();
    assert.ok(!existsSync(join(modelDir(), "config.json")));
    assert.ok(!existsSync(join(modelDir(), "onnx/model_quantized.onnx")));
    const c2 = w.client();
    await c2.hello();
    const id2 = (await c2.call("reindex_source", { project_id: "demo", source_id: "primary", mode: "full" })).value.job_id;
    const done = await until(async () => {
      const s = (await c2.call("reindex_status", { job_id: id2 })).value;
      await sleep(50);
      return ["done", "failed"].includes(s?.status) && s;
    }, 60_000, "the second job");
    assert.equal(done.status, "failed", JSON.stringify(done));
    assert.match(done.tasks[0].error, /^Local embedder failed to load: /);
    intact();
  });
});

test("the run's commands", () => {
  assert.ok(SERVER.length && CLI.length && RELAY.length);
});

// Today's blend, written out from its definition, to judge either build's order and scores.
function expectedBlend(docs, scores, topK, top3 = [0.75, 0.25], tail = [0.40, 0.60]) {
  const n = docs.length;
  const lo = Math.min(...scores), hi = Math.max(...scores), range = hi - lo;
  const weights = (rank) => {
    if (rank <= 3) return top3;
    if (rank >= 11) return tail;
    const t = (rank - 3) / 8;
    return [top3[0] + t * (tail[0] - top3[0]), top3[1] + t * (tail[1] - top3[1])];
  };
  const rows = docs.map((doc, i) => {
    const rank = i + 1;
    const normRank = n === 1 ? 1 : 1 - (rank - 1) / (n - 1);
    const normRerank = range < 1e-10 ? 1 : (scores[i] - lo) / range;
    const [wr, wx] = weights(rank);
    return { doc, score: wr * normRank + wx * normRerank };
  });
  rows.sort((a, b) => b.score - a.score);
  return rows.slice(0, topK);
}

const RERANK_ENV = (rr) => ({ SCRYBE_RERANK: "true", SCRYBE_RERANK_BASE_URL: rr.url, SCRYBE_RERANK_MODEL: "fake-rerank", SCRYBE_RERANK_API_KEY: "contract-rerank-key" });

function checkRerankCall(rr, query, topK, value) {
  assert.equal(rr.log.length, 1, "one rerank request per search");
  const { auth, contentType, body } = rr.log[0];
  assert.equal(auth, "Bearer contract-rerank-key");
  assert.match(contentType, /^application\/json/);
  assert.deepEqual(Object.keys(body), ["model", "query", "documents", "top_k", "return_documents"]);
  assert.equal(body.model, "fake-rerank");
  assert.equal(body.query, query);
  assert.equal(body.return_documents, false);
  assert.equal(body.top_k, body.documents.length);
  assert.ok(body.documents.length > topK, `only ${body.documents.length} candidates: the fetch multiplier was not applied`);
  assert.ok(body.documents.length <= topK * 5);
  const want = expectedBlend(body.documents, body.documents.map((d) => rerankScoreFor(query, d)), topK);
  assert.deepEqual(value.map((h) => h.content), want.map((r) => r.doc));
  for (let i = 0; i < want.length; i++) assert.ok(Math.abs(value[i].score - want[i].score) < 1e-12, `score ${i}: ${value[i].score} vs ${want[i].score}`);
  // Printed so two builds' runs can be compared line for line.
  console.log(`RERANK-DUMP ${JSON.stringify({ query, candidates: body.documents.length, out: value.map((h) => [h.item_path, h.score]) })}`);
}

describe("reranking over HTTP", () => {
  let rr, gl, w, c;
  before(async () => {
    rr = await fakeReranker();
    gl = await fakeGitlab();
    seedGitlab(gl);
    w = await makeWorld({ extraSources: [ticketSource(gl)], serverEnv: { CONTRACT_GITLAB_TOKEN: GITLAB_TOKEN, ...RERANK_ENV(rr) } });
    await w.index("--full");
    const r = await indexIssues(w, "--full");
    assert.equal(r.status, 0, r.stderr + r.stdout);
    c = w.client();
    await c.hello();
  });
  after(async () => { await w.stop(); gl.close(); rr.close(); });

  test("search_code sends every candidate and returns the blended order", async () => {
    rr.log.length = 0;
    const { value, isError, text } = await c.call("search_code", { project_id: "demo", query: "widget", top_k: 2 });
    assert.equal(isError, false, text);
    assert.equal(value.length, 2);
    checkRerankCall(rr, "widget", 2, value);
  });

  test("search_knowledge reranks issues the same way", async () => {
    rr.log.length = 0;
    const { value, isError, text } = await c.call("search_knowledge", { project_id: "demo", query: "Pagination check", top_k: 3, source_id: "issues" });
    assert.equal(isError, false, text);
    assert.equal(value.length, 3);
    checkRerankCall(rr, "Pagination check", 3, value);
  });
});

describe("reranking when it can't run", () => {
  test("a reranker that answers with an error fails the search", async () => {
    const rr = await fakeReranker({ status: 503 });
    const w = await makeWorld({ serverEnv: RERANK_ENV(rr) });
    try {
      await w.index("--full");
      const c = w.client();
      await c.hello();
      const { isError } = await c.call("search_code", { project_id: "demo", query: "widget", top_k: 2 });
      assert.equal(isError, true);
      assert.equal(rr.log.length, 1);
    } finally { await w.stop(); rr.close(); }
  });

  test("rerank switched on with no reranker named searches without one", async () => {
    const w = await makeWorld({ serverEnv: { SCRYBE_RERANK: "true" } });
    try {
      await w.index("--full");
      const c = w.client();
      await c.hello();
      const { value, isError, text } = await c.call("search_code", { project_id: "demo", query: "frobnicateWidget", top_k: 2 });
      assert.equal(isError, false, text);
      assert.equal(value.length, 2);
      assert.ok(value.some((h) => h.symbol_name === "frobnicateWidget"));
    } finally { await w.stop(); }
  });
});

describe("reranking with the local cross-encoder", () => {
  // Needs the model folder's parent cache, so it runs only when SCRYBE_CONTRACT_RERANK_CACHE points at one.
  const cache = process.env.SCRYBE_CONTRACT_RERANK_CACHE;
  let gl, w, c;
  before(async () => {
    if (!cache) return;
    gl = await fakeGitlab();
    seedGitlab(gl);
    w = await makeWorld({ extraSources: [ticketSource(gl)], serverEnv: { CONTRACT_GITLAB_TOKEN: GITLAB_TOKEN, SCRYBE_RERANK: "true", SCRYBE_RERANK_PROVIDER: "local", SCRYBE_MODEL_CACHE_DIR: cache } });
    await w.index("--full");
    const r = await indexIssues(w, "--full");
    assert.equal(r.status, 0, r.stderr + r.stdout);
    c = w.client();
    await c.hello();
  });
  after(async () => { if (cache) { await w.stop(); gl.close(); } });

  for (const [tool, args] of [["search_code", { query: "widen the widget", top_k: 3 }], ["search_knowledge", { query: "Pagination check", top_k: 5, source_id: "issues" }]]) {
    test(`${tool} reranks locally`, async (t) => {
      if (!cache) return t.skip("set SCRYBE_CONTRACT_RERANK_CACHE to a model cache holding the cross-encoder");
      const { value, isError, text } = await c.call(tool, { project_id: "demo", ...args });
      assert.equal(isError, false, text);
      assert.equal(value.length, args.top_k);
      for (let i = 1; i < value.length; i++) assert.ok(value[i - 1].score >= value[i].score);
      console.log(`RERANK-LOCAL-DUMP ${JSON.stringify({ tool, out: value.map((h) => [h.item_path, Number(h.score.toFixed(3))]) })}`);
    });
  }
});

/** One request, its body sent in the pieces given, as chunks unless the headers name a length. */
const rawRequest = (port, method, path, pieces, headers = {}) => new Promise((resolve, reject) => {
  const framing = pieces.length > 0 && !("Content-Length" in headers) ? { "Transfer-Encoding": "chunked" } : {};
  const req = httpRequest({ host: "127.0.0.1", port, method, path, headers: { "Content-Type": "application/json", ...framing, ...headers } }, (res) => {
    let text = "";
    res.on("data", (d) => { text += d; });
    res.on("end", () => {
      let body;
      try { body = JSON.parse(text); } catch { /* not JSON */ }
      resolve({ status: res.statusCode, text, body });
    });
  });
  req.on("error", reject);
  (async () => {
    for (const p of pieces) { req.write(p); await sleep(30); }
    req.end();
  })();
});

const startedServer = async (w) => {
  const c = w.client();
  await c.hello();
  await c.rpc("tools/list");
  await until(() => w.pidfile(), 10_000, "the pidfile");
  return { c, port: w.pidfile().port, base: `http://127.0.0.1:${w.pidfile().port}` };
};

describe("request bodies", () => {
  let w, c, port;
  const PINNED = "/projects/demo/sources/primary/pinned-branches";
  const jobCount = async () => (await c.call("list_jobs")).value.count;
  before(async () => {
    w = await makeWorld();
    await w.index("--full");
    ({ c, port } = await startedServer(w));
  });
  after(() => w.stop());

  test("a malformed body is a 500 and starts nothing", async () => {
    const jobs = await jobCount();
    for (const [method, path, field] of [["POST", "/kick", "projectId"], ["POST", "/gc", "mode"], ["POST", "/clients/heartbeat", "clientId"], ["POST", "/clients/unregister", "clientId"], ["POST", PINNED, "branches"], ["DELETE", PINNED, "branches"]]) {
      const broken = await rawRequest(port, method, path, ['{"projectId": "demo"']);
      assert.equal(broken.status, 500, `${path}: ${broken.text}`);
      assert.deepEqual(Object.keys(broken.body), ["error"]);
      assert.match(broken.body.error, /^SyntaxError: /);
      const none = await rawRequest(port, method, path, ["null"]);
      assert.deepEqual([none.status, none.body], [500, { error: `TypeError: Cannot read properties of null (reading '${field}')` }], path);
    }
    const scope = await rawRequest(port, "POST", "/gc", ['{"scope": "demo"}']);
    assert.deepEqual([scope.status, scope.body], [500, { error: "TypeError: scope.map is not a function" }]);
    assert.equal(await jobCount(), jobs);
    assert.deepEqual((await rawRequest(port, "GET", PINNED, [])).body, { branches: [] });
  });

  test("an id that isn't text never widens the request", async () => {
    const demoJobs = async () => (await c.call("list_jobs")).value.jobs.filter((j) => j.project_id === "demo").length;
    const jobs = await demoJobs();
    const r = await rawRequest(port, "POST", "/kick", ['{"projectId": ["demo"]}']);
    assert.equal(r.status, 200, r.text);
    assert.equal(r.body.jobs.length, 1);
    assert.equal(await demoJobs(), jobs);
  });

  test("a full run without a source is refused, and a project that isn't there gets its failed job", async () => {
    const embedded = w.fake.log.length;
    for (const body of ['{"mode": "full"}', '{"projectId": "demo", "mode": "full"}', '{"projectId": "demo", "sourceId": "", "mode": "full"}']) {
      const r = await rawRequest(port, "POST", "/kick", [body]);
      assert.deepEqual([r.status, r.body], [500, { error: "Error: full reindex requires explicit source_ids" }], body);
    }
    const gone = await rawRequest(port, "POST", "/kick", ['{"projectId": "nope", "mode": "full"}']);
    assert.equal(gone.status, 200, gone.text);
    assert.equal((await c.call("reindex_status", { job_id: gone.body.jobs[0].jobId })).value.error, "project no longer exists");
    const r = await c.call("reindex_source", { project_id: "demo", source_id: "", mode: "full" });
    assert.ok(r.isError || r.rpcError || (await until(async () => (await c.call("reindex_status", { job_id: r.value.job_id })).value?.status !== "running", 10_000, "the job")), r.text);
    assert.equal(w.fake.log.length, embedded, "nothing was embedded again");
    assert.equal((await c.call("lookup_symbol", { project_id: "demo", symbol_name: "frobnicateWidget" })).value.length, 1);
  });

  test("empty ids stand for every project and every source", async () => {
    const r = await rawRequest(port, "POST", "/kick", ['{"projectId": "", "sourceId": ""}']);
    assert.equal(r.status, 200, r.text);
    assert.deepEqual(r.body.jobs.map((j) => j.projectId), ["demo"]);
    const done = await until(async () => {
      const s = (await c.call("reindex_status", { job_id: r.body.jobs[0].jobId })).value;
      return ["done", "failed"].includes(s?.status) && s;
    }, 30_000, "the job");
    assert.equal(done.status, "done", JSON.stringify(done));
    assert.deepEqual(done.tasks.map((t) => t.source_id), ["primary"]);
  });

  test("a body sent in chunks is read, and a large one isn't refused", async () => {
    const chunked = await rawRequest(port, "POST", "/kick", ['{"project', 'Id": "no', 'pe"}']);
    assert.equal(chunked.status, 200, chunked.text);
    assert.deepEqual(chunked.body.jobs.map((j) => j.projectId), ["nope"]);
    const big = JSON.stringify({ projectId: "nope", padding: "x".repeat(9 << 20) });
    for (const headers of [{}, { "Content-Length": big.length }]) {
      const r = await rawRequest(port, "POST", "/kick", [big], headers);
      assert.equal(r.status, 200, r.text);
      assert.deepEqual(r.body.jobs.map((j) => j.projectId), ["nope"]);
    }
  });

  test("a call without an id or a method is an invalid request", async () => {
    const rpc = async (body) => (await rawRequest(port, "POST", "/mcp/rpc", [body])).body;
    const invalid = (id) => ({ id, error: { code: -32600, message: "invalid request: missing id or method" } });
    for (const body of ['{"method": "list_projects", "params": {}}', "{}", "", "[]", "5"]) assert.deepEqual(await rpc(body), invalid(null), body);
    for (const body of ['{"id": 7}', '{"id": 7, "method": 5}', '{"id": 7, "method": ""}', '{"id": 7, "method": null}']) assert.deepEqual(await rpc(body), invalid(7), body);
    assert.deepEqual(await rpc("{nope"), { id: null, error: { code: -32600, message: "invalid request: body is not valid JSON" } });
    const none = await rawRequest(port, "POST", "/mcp/rpc", ["null"]);
    assert.deepEqual([none.status, none.body], [500, { error: "TypeError: Cannot read properties of null (reading 'id')" }]);
    for (const params of ["", ', "params": null', ', "params": []', ', "params": "x"']) {
      const r = await rpc(`{"id": null, "method": "list_projects"${params}}`);
      assert.equal(r.id, null);
      assert.equal(r.result[0].id, "demo", JSON.stringify(r));
    }
  });
});

describe("a malformed body on the opt-in MCP endpoint", () => {
  test("is a parse error", async () => {
    const w = await makeWorld();
    w.env.SCRYBE_DAEMON_MCP_HTTP = "1";
    try {
      const { port } = await startedServer(w);
      const r = await rawRequest(port, "POST", "/mcp", ["{nope"], { Accept: "application/json, text/event-stream" });
      assert.deepEqual([r.status, r.body], [400, { jsonrpc: "2.0", error: { code: -32700, message: "Parse error: Invalid JSON" }, id: null }]);
    } finally { await w.stop(); }
  });
});

describe("garbage collection when the tags can't be read", () => {
  let w;
  before(async () => { w = await makeWorld(); await w.index("--full"); await w.cli("projects"); });
  after(() => w.stop());
  const sql = (text) => {
    const db = new DatabaseSync(join(w.data, "branch-tags.db"));
    db.exec(text);
    db.close();
  };
  // A view in the table's place is there for a schema check and fails every read.
  const breakTags = () => sql("ALTER TABLE branch_tags RENAME TO kept_tags; CREATE VIEW branch_tags AS SELECT * FROM no_such_table;");
  const mendTags = () => sql("DROP VIEW branch_tags; ALTER TABLE kept_tags RENAME TO branch_tags;");
  const stillThere = async () => {
    const r = await w.cli("gc", "--dry-run");
    assert.deepEqual([r.status, r.stdout], [0, "No orphan chunks found.\n"], r.stderr);
    const found = await w.cli("search", "code", "-P", "demo", "frobnicateWidget");
    assert.match(found.stdout, /src\/widget\.ts/, found.stderr);
  };

  test("the command fails and deletes nothing", async () => {
    breakTags();
    try {
      const r = await w.cli("gc");
      assert.notEqual(r.status, 0, r.stdout);
      assert.ok(!r.stdout.includes("orphan chunk(s) deleted"), r.stdout);
    } finally { mendTags(); }
    await stillThere();
  });

  test("the server's job fails and deletes nothing", async () => {
    const { c, port } = await startedServer(w);
    breakTags();
    try {
      const { body } = await rawRequest(port, "POST", "/gc", ['{"scope": ["demo"]}']);
      const id = body.jobs[0].jobId;
      const done = await until(async () => {
        const s = (await c.call("reindex_status", { job_id: id })).value;
        return ["done", "failed"].includes(s?.status) && s;
      }, 30_000, "the gc job");
      assert.equal(done.status, "failed", JSON.stringify(done));
      assert.match(done.error, /no_such_table/);
    } finally { mendTags(); }
    const { body } = await rawRequest(port, "POST", "/gc", ['{"scope": ["demo"], "sourceId": ""}']);
    const done = await until(async () => {
      const s = (await c.call("reindex_status", { job_id: body.jobs[0].jobId })).value;
      return ["done", "failed"].includes(s?.status) && s;
    }, 30_000, "the next gc job");
    assert.equal(done.status, "done", JSON.stringify(done));
    assert.equal(JSON.parse(done.result).orphans_deleted, 0);
    await w.killServer();
    await stillThere();
  });
});

describe("a full run cancelled while it scans", () => {
  let gl, w, c, base;
  before(async () => {
    gl = await fakeGitlab();
    seedGitlab(gl);
    w = await makeWorld({ extraSources: [ticketSource(gl)], serverEnv: { CONTRACT_GITLAB_TOKEN: GITLAB_TOKEN } });
    await w.index("--full");
    const r = await indexIssues(w, "--full");
    assert.equal(r.status, 0, r.stderr + r.stdout);
  });
  after(async () => { await w.stop(); gl.close(); });
  const ended = (id) => until(async () => {
    const s = (await c.call("reindex_status", { job_id: id })).value;
    return s?.status !== "running" && s;
  }, 30_000, "the job to end");

  test("keeps the issues it had", async (t) => {
    ({ c, base } = await startedServer(w));
    const before = await knowledgeRows(w);
    if (!before) return t.skip("no LanceDB module to read the table with: set SCRYBE_CONTRACT_NODE_MODULES");
    const asked = gl.state.log.length;
    let release;
    gl.state.hold = new Promise((r) => { release = r; });
    const id = (await c.call("reindex_source", { project_id: "demo", source_id: "issues", mode: "full" })).value.job_id;
    await until(() => gl.state.log.length > asked, 10_000, "the scan to start");
    const answer = await (await fetch(`${base}/jobs/${id}`, { method: "DELETE" })).json();
    assert.deepEqual(answer, { job_id: id, cancelled: true });
    release();
    gl.state.hold = null;
    assert.equal((await ended(id)).status, "cancelled");
    assert.deepEqual(summarize(await knowledgeRows(w)), summarize(before));
  });

  // Today's build reads the git tree without a pause, so a cancel can't reach it until the scan is over.
  const skip = BUILD === "ts" ? "today's build can't hear a cancel during this scan" : process.platform === "win32" ? "needs a shell script in git's place" : false;
  test("keeps the code it had", { skip }, async () => {
    const bin = join(w.dir, "bin"), held = join(w.dir, "held"), seen = join(w.dir, "seen");
    mkdirSync(bin);
    writeFileSync(join(bin, "git"), `#!/bin/sh\nif [ "$1" = ls-tree ] && [ -e "${held}" ]; then touch "${seen}"; while [ -e "${held}" ]; do sleep 0.1; done; fi\nPATH="\${PATH#*:}" exec git "$@"\n`, { mode: 0o755 });
    await w.killServer();
    w.env.PATH = `${bin}:${w.env.PATH}`;
    let r = await w.cli("index", "-P", "demo", "-S", "primary", "--branch", "side");
    assert.equal(r.status, 0, r.stderr + r.stdout);
    ({ c, base } = await startedServer(w));
    writeFileSync(held, "");
    const id = (await c.call("reindex_source", { project_id: "demo", source_id: "primary", mode: "full", branch: "side" })).value.job_id;
    await until(() => existsSync(seen), 10_000, "the scan to start");
    await fetch(`${base}/jobs/${id}`, { method: "DELETE" });
    rmSync(held);
    assert.equal((await ended(id)).status, "cancelled");
    for (const name of ["frobnicateWidget", "onlyOnTheSideBranch"]) {
      assert.equal((await c.call("lookup_symbol", { project_id: "demo", symbol_name: name, branch: "side" })).value.length, 1, name);
    }
  });
});

describe("odd project lists", () => {
  let w;
  before(async () => { w = await makeWorld(); await w.cli("projects"); });
  after(() => w.stop());
  const path = () => join(w.data, "projects.json");
  const write = (list) => writeFileSync(path(), JSON.stringify(list, null, 2));

  test("a project in the old flat shape becomes a primary source, and the file is saved that way", async () => {
    write([
      { id: "flat", description: "old", root_path: w.repo, languages: ["ts"], last_indexed: "2026-01-02T03:04:05.000Z", extra: 1 },
      { id: "tracker", source_config: { type: "ticket", provider: "gitlab", base_url: "", project_id: "1", token: "${X}" }, sources: null },
      { id: "demo", description: "A demo", sources: [] },
    ]);
    const r = await w.cli("project", "list");
    assert.equal(r.status, 0, r.stderr);
    for (const id of ["flat", "tracker"]) {
      assert.ok(r.stderr.includes(`[scrybe] Migrated project '${id}' to multi-source model (source_id: "primary"). Run a full reindex to rebuild its vector table.`), r.stderr);
    }
    assert.match(r.stdout, /\nflat — old\n {2}\S primary +code +2026-01-02 03:04\n/);
    assert.match(r.stdout, /\ndemo — A demo\n/);
    const want = [
      { id: "flat", description: "old", extra: 1, sources: [{ source_id: "primary", source_config: { type: "code", root_path: w.repo, languages: ["ts"] }, last_indexed: "2026-01-02T03:04:05.000Z" }] },
      { id: "tracker", sources: [{ source_id: "primary", source_config: { type: "ticket", provider: "gitlab", base_url: "", project_id: "1", token: "${X}" } }] },
      { id: "demo", description: "A demo", sources: [] },
    ];
    assert.equal(readFileSync(path(), "utf8"), JSON.stringify(want, null, 2));
    const again = await w.cli("project", "list");
    assert.deepEqual([again.stdout, again.stderr], [r.stdout, ""]);
  });

  test("-P shows a flat project in its new shape", async () => {
    write([{ id: "flat", root_path: w.repo }]);
    const r = await w.cli("status", "-P", "flat");
    assert.equal(r.status, 0, r.stderr);
    const shown = JSON.parse(r.stdout.slice(0, r.stdout.indexOf("\nData dir: ")));
    assert.deepEqual(shown.sources.map((s) => [s.source_id, s.source_config]), [["primary", { type: "code", root_path: w.repo, languages: [] }]]);
  });

  test("a field of the wrong type in one entry hides nothing else", async () => {
    write([
      { id: "odd", description: 3, sources: [{ source_id: "s", source_config: { type: "code", root_path: w.repo, languages: "ts" }, table_name: 5, pinned_branches: "main" }] },
      { description: "no id", sources: [] },
      { id: "demo", description: "A demo", sources: [{ source_id: "primary", source_config: { type: "code", root_path: w.repo, languages: [] } }] },
    ]);
    const { c } = await startedServer(w);
    const { value, isError, text } = await c.call("list_projects");
    assert.equal(isError, false, text);
    assert.deepEqual(value.filter((p) => p.id).map((p) => [p.id, p.sources.map((s) => s.source_id)]), [["odd", ["s"]], ["demo", ["primary"]]]);
    await w.killServer();
  });

  test("a file that isn't a list is not replaced by a new one", async () => {
    writeFileSync(path(), '{"not": "a list"}');
    const r = await w.cli("project", "add", "--id", "fresh");
    assert.equal(r.status, 1, r.stdout);
    assert.equal(readFileSync(path(), "utf8"), '{"not": "a list"}');
  });

  test("source add before any project says the project isn't there", async () => {
    rmSync(path());
    const r = await w.cli("source", "add", "-P", "demo", "-S", "x", "--type", "code", "--root", w.repo);
    assert.deepEqual([r.status, r.stdout, r.stderr], [1, "", "[scrybe] Project 'demo' not found\n"]);
  });
});

describe("a project list that can't be saved", () => {
  let w, c, port;
  const PINNED = "/projects/demo/sources/primary/pinned-branches";
  // A folder where the new file is first written fails for any user.
  const block = () => mkdirSync(join(w.data, "projects.json.tmp"));
  const unblock = () => rmSync(join(w.data, "projects.json.tmp"), { recursive: true });
  before(async () => {
    w = await makeWorld({ pinned: ["side"] });
    ({ c, port } = await startedServer(w));
    await until(async () => (await c.call("queue_status")).value.running.length === 0, 30_000, "the queue to settle");
  });
  after(() => w.stop());

  test("fails every change to it and keeps what was there", async () => {
    const before = readFileSync(join(w.data, "projects.json"), "utf8");
    block();
    try {
      for (const [method, path, body] of [["POST", PINNED, '{"branches": ["x"]}'], ["DELETE", PINNED, '{"branches": ["side"]}'], ["DELETE", `${PINNED}?all=true`, ""]]) {
        const r = await rawRequest(port, method, path, [body]);
        assert.equal(r.status, 500, r.text);
        assert.deepEqual(Object.keys(r.body), ["error"]);
        assert.match(r.body.error, /^Error: .*projects\.json\.tmp/s);
      }
      for (const [tool, args] of [["pin_branches", { source_id: "primary", branches: ["y"] }], ["unpin_branches", { source_id: "primary", branches: ["side"] }], ["update_project", { description: "new" }], ["update_source", { source_id: "primary", root_path: w.dir }]]) {
        const r = await c.call(tool, { project_id: "demo", ...args });
        assert.ok(r.isError || r.rpcError, `${tool}: ${r.text}`);
      }
      const r = await c.call("add_project", { project_id: "fresh" });
      assert.ok(r.isError || r.rpcError, r.text);
      const cli = await w.cli("branch", "pin", "-P", "demo", "z");
      assert.equal(cli.status, 1, cli.stdout);
    } finally { unblock(); }
    assert.equal(readFileSync(join(w.data, "projects.json"), "utf8"), before);
    assert.deepEqual((await rawRequest(port, "GET", PINNED, [])).body, { branches: ["side"] });
  });
});

describe("start-up settings", () => {
  let w;
  before(async () => { w = await makeWorld(); await w.cli("projects"); });
  after(() => w.stop());

  test("an overlap as long as the chunk is refused by every command", async () => {
    for (const [size, overlap, said] of [["10", "10", "(10) must be less than SCRYBE_CHUNK_SIZE (10)"], ["5 lines", "", "(10) must be less than SCRYBE_CHUNK_SIZE (5)"], ["20", "30", "(30) must be less than SCRYBE_CHUNK_SIZE (20)"]]) {
      const r = await w.cliWith({ SCRYBE_CHUNK_SIZE: size, ...(overlap ? { SCRYBE_CHUNK_OVERLAP: overlap } : {}) }, "project", "list");
      assert.deepEqual([r.status, r.stdout, r.stderr], [1, "", `scrybe error: Error: Invalid chunking config: SCRYBE_CHUNK_OVERLAP ${said}. Defaults: size=60, overlap=10.\n`]);
    }
    const ok = await w.cliWith({ SCRYBE_CHUNK_SIZE: "11" }, "project", "list");
    assert.equal(ok.status, 0, ok.stderr);
  });

  test("a port that isn't one stops the server, and 0 takes any", async (t) => {
    for (const [port, got] of [["abc", "NaN"], ["", "NaN"], ["70000", "70000"], ["-1", "-1"]]) {
      const r = await w.cliWith({ SCRYBE_DAEMON_PORT: port }, "daemon", "start");
      assert.equal(r.status, 1, r.stdout);
      assert.ok(r.stderr.includes(`options.port should be >= 0 and < 65536. Received type number (${got}).`), r.stderr);
      assert.equal(w.pidfile(), null);
    }
    const c = w.client({ extraEnv: { SCRYBE_DAEMON_PORT: "0xyz" } });
    await c.hello();
    await c.rpc("tools/list");
    if (!w.pidfile()) return t.skip("no server on this host");
    assert.ok(w.pidfile().port > 0);
    await w.killServer();
  });

  const privileged = process.platform !== "linux" || process.getuid() === 0 || Number(readFileSync("/proc/sys/net/ipv4/ip_unprivileged_port_start", "utf8")) <= 1;
  test("a port this user may not have says where to look", { skip: privileged ? "this user may bind any port" : false }, async () => {
    const r = await w.cliWith({ SCRYBE_DAEMON_PORT: "1" }, "daemon", "start");
    assert.equal(r.status, 1, r.stdout);
    assert.ok(r.stderr.includes("Error: Port 1 (from SCRYBE_DAEMON_PORT) is unavailable to this process. On Windows this usually means another component (Hyper-V, WSL, etc.) has reserved it at boot. Run `netsh interface ipv4 show excludedportrange protocol=tcp` to see the reserved ranges, or unset SCRYBE_DAEMON_PORT to let the daemon pick a free port itself."), r.stderr);
  });
});

describe("a pidfile somewhere else", () => {
  test("is the one the server, the client and the command line use", async (t) => {
    const w = await makeWorld();
    const file = join(w.dir, "elsewhere.pid");
    w.env.SCRYBE_DAEMON_PIDFILE = file;
    const read = () => { try { return JSON.parse(readFileSync(file, "utf8")); } catch { return null; } };
    try {
      const first = w.client();
      await first.hello();
      await first.toolNames();
      const pf = await until(read, 10_000, "the pidfile");
      assert.equal(w.pidfile(), null, "nothing in the usual place");
      const second = w.client();
      await second.hello();
      assert.equal((await second.call("status")).value.daemon_pid, pf.pid);
      const shown = await w.cliLive("daemon", "status");
      if (!shown.stdout.startsWith("{")) return t.skip(`this host's command line sees no server: ${shown.stdout}`);
      assert.equal(JSON.parse(shown.stdout).pid, pf.pid);
      const json = JSON.parse((await w.cliLive("status", "--json")).stdout);
      assert.equal(json.daemon.pid, pf.pid);
      const r = await w.cliLive("daemon", "stop");
      assert.deepEqual([r.status, r.stdout], [0, "Daemon stopped.\n"], r.stderr);
      assert.equal(read(), null);
    } finally {
      const pf = read();
      if (pf) { try { process.kill(pf.pid, "SIGKILL"); } catch { /* gone */ } }
      await w.stop();
    }
  });
});

describe("status when something else answers on the port", () => {
  test("only a server's own 2xx answer counts as running", async () => {
    const w = await makeWorld();
    const stand = spawn(process.execPath, ["-e", "setTimeout(() => {}, 120000)"], { stdio: "ignore", windowsHide: true });
    let answer;
    const { createServer } = await import("node:http");
    const server = createServer((req, res) => { res.writeHead(answer[0], { "Content-Type": "application/json" }); res.end(JSON.stringify(answer[1])); });
    await new Promise((r) => server.listen(0, "127.0.0.1", r));
    const good = { pid: stand.pid, uptimeMs: 1, queue: { active: 0, pending: 0 } };
    try {
      writeFileSync(join(w.data, "daemon.pid"), JSON.stringify({ pid: stand.pid, port: server.address().port, startedAt: "", version: "", dataDir: w.data, execPath: "" }));
      const running = async () => JSON.parse((await w.cli("status", "--json")).stdout.replace(/^[^{]*/, "")).daemon.running;
      answer = [200, good];
      assert.equal(await running(), true);
      for (answer of [[500, good], [404, { error: "Not found" }], [503, good], [200, {}]]) assert.equal(await running(), false, JSON.stringify(answer));
    } finally {
      rmSync(join(w.data, "daemon.pid"), { force: true });
      server.close();
      stand.kill();
      await w.stop();
    }
  });
});

describe("the client named on requests going out", () => {
  test("the trackers, the embedder and the reranker all see one", async () => {
    const gl = await fakeGitlab(), gh = await fakeGithub(), rr = await fakeReranker();
    seedGitlab(gl);
    seedGithub(gh);
    const w = await makeWorld({ extraSources: [ticketSource(gl), { ...githubSource(gh), source_id: "hub" }], serverEnv: { CONTRACT_GITLAB_TOKEN: GITLAB_TOKEN, CONTRACT_GITHUB_TOKEN: GITHUB_TOKEN, ...RERANK_ENV(rr) } });
    try {
      await w.index("--full");
      for (const source of ["issues", "hub"]) {
        const r = await w.cli("index", "-P", "demo", "-S", source, "--full");
        assert.equal(r.status, 0, r.stderr + r.stdout);
      }
      const r = await w.cli("search", "code", "-P", "demo", "widget");
      assert.equal(r.status, 0, r.stderr);
      for (const log of [gl.state.log, gh.state.log, rr.log]) {
        assert.ok(log.length > 0);
        assert.deepEqual([...new Set(log.map((l) => l.agent))], ["node"]);
      }
      assert.ok(w.fake.log.length > 0 && w.fake.log.every((l) => l.agent), JSON.stringify(w.fake.log[0]));
    } finally {
      await w.stop();
      for (const s of [gl, gh, rr]) s.close();
    }
  });
});

const tableOf = (w, i = 0) => JSON.parse(readFileSync(join(w.data, "projects.json"), "utf8"))[0].sources[i].table_name;
const changeConfig = (w, change) => {
  const file = join(w.data, "config.json");
  const cfg = JSON.parse(readFileSync(file, "utf8"));
  change(cfg);
  writeFileSync(file, JSON.stringify(cfg));
};
/** The tools over stdio in one process of their own, where a failure keeps its type and details. */
const stdioTools = (w, extra = {}) => {
  const p = spawn(CLI[0], [...CLI.slice(1), "mcp", "--legacy-in-process"], { env: { ...w.env, SCRYBE_NO_AUTO_DAEMON: "1", ...extra }, stdio: ["pipe", "pipe", "ignore"], windowsHide: true });
  const waiting = new Map();
  let buf = "", next = 0;
  p.stdout.on("data", (d) => {
    buf += d;
    for (let i = buf.indexOf("\n"); i >= 0; i = buf.indexOf("\n")) {
      const line = buf.slice(0, i);
      buf = buf.slice(i + 1);
      let m;
      try { m = JSON.parse(line); } catch { continue; }
      waiting.get(m.id)?.(m);
    }
  });
  const send = (m) => p.stdin.write(JSON.stringify({ jsonrpc: "2.0", ...m }) + "\n");
  const rpc = (method, params) => new Promise((resolve, reject) => {
    const id = ++next;
    const timer = setTimeout(() => reject(new Error(`no answer to ${method}`)), 60_000);
    waiting.set(id, (m) => { clearTimeout(timer); resolve(m); });
    send({ id, method, params });
  });
  const ready = rpc("initialize", { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "contract", version: "1" } }).then(() => send({ method: "notifications/initialized" }));
  return {
    async call(name, args) {
      await ready;
      return JSON.parse((await rpc("tools/call", { name, arguments: { project_id: "demo", query: "widget", ...args } })).result.content[0].text);
    },
    stop: () => p.kill("SIGKILL"),
  };
};
const onStdio = async (w, name, args) => {
  const tools = stdioTools(w);
  try { return await tools.call(name, args); } finally { tools.stop(); }
};
/** Empties the newest manifest of a table, whose file names may count up or down. */
const emptyManifests = (w, table) => {
  const dir = join(w.data, "lancedb", `${table}.lance`, "_versions");
  for (const f of readdirSync(dir).filter((f) => f.endsWith(".manifest"))) writeFileSync(join(dir, f), "");
};

describe("a table that can't be read", () => {
  let gl, w;
  before(async () => {
    gl = await fakeGitlab();
    seedGitlab(gl);
    w = await makeWorld({ extraSources: [ticketSource(gl)], serverEnv: { CONTRACT_GITLAB_TOKEN: GITLAB_TOKEN } });
    await w.index("--full");
    const r = await indexIssues(w, "--full");
    assert.equal(r.status, 0, r.stderr + r.stdout);
  });
  afterEach(() => w.killServer());
  after(async () => { await w.stop(); gl.close(); });
  const onServer = async (tool = "search_code", extra = {}) => {
    const c = w.client();
    await c.hello();
    return c.call(tool, { project_id: "demo", query: "widget", ...extra });
  };
  const faultOf = (value, text, reason) => {
    assert.equal(value.error_type, "table_corrupt", JSON.stringify(value).slice(0, 300));
    assert.equal(value.error, `Source 'demo/primary' ${text}. Run: scrybe index -P demo -S primary --full`);
    const { project_id, source_id, reasons, ...details } = value.details;
    assert.deepEqual([project_id, source_id, reasons], ["demo", "primary", [reason]]);
    return details;
  };
  const withDim = async (dim, f) => {
    changeConfig(w, (c) => { c.embedding_presets.fake.dim = dim; });
    try { return await f(); } finally { changeConfig(w, (c) => { c.embedding_presets.fake.dim = 8; }); }
  };

  test("a search with other vector sizes configured names both", () => withDim(16, async () => {
    const value = await onStdio(w, "search_code", {});
    assert.deepEqual(faultOf(value, "has a dimensions mismatch (indexed at 8, embedder is now 16)", "dimensions_mismatch"), { expected_dimensions: 16, actual_dimensions: 8 });
  }));

  test("a gc that leaves one behind is announced", async () => {
    const { base } = await startedServer(w);
    await withDim(16, async () => {
      const res = await fetch(`${base}/gc`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ scope: ["demo"], mode: "purge" }) });
      assert.ok(res.ok, `${res.status}`);
      const [ev] = await until(() => { const found = w.logged("health.post-gc-corruption-detected"); return found.length > 0 && found; }, 20_000, "the announcement");
      assert.deepEqual([ev.level, ev.projectId, ev.sourceId], ["error", "demo", "primary"]);
      assert.deepEqual([ev.detail.tableName, ev.detail.reasons, ev.detail.details, ev.detail.gcMode], [tableOf(w), ["dimensions_mismatch"], { expected_dimensions: 16, actual_dimensions: 8 }, "purge"]);
      assert.match(ev.detail.gcJobId, /^[0-9a-f-]{8,}$/);
    });
  });

  test("a search of a table whose data is gone says so, and the server announced it at start", async () => {
    const dir = join(w.data, "lancedb", `${tableOf(w)}.lance`, "data");
    const files = readdirSync(dir).filter((f) => f.endsWith(".lance"));
    const kept = files.map((f) => [f, readFileSync(join(dir, f))]);
    for (const f of files) rmSync(join(dir, f));
    const before = w.logged("health.corrupt").length;
    const value = await onStdio(w, "search_code", {});
    const details = faultOf(value, "has a corrupt index (manifest references 1 missing data file)", "manifest_missing_data");
    assert.equal(details.missing_files.length, 1);
    assert.ok(files.includes(details.missing_files[0].replace(/^data\//, "")), JSON.stringify(details));
    const all = await onStdio(w, "search_knowledge", {});
    assert.equal(all.error_type, "table_corrupt", "every source of the project is looked at");
    assert.ok(Array.isArray(await onStdio(w, "search_knowledge", { source_id: "issues" })));
    const shell = await w.cli("search", "code", "-P", "demo", "widget");
    assert.equal(shell.status, 1);
    assert.match(shell.stderr + shell.stdout, /Source 'demo\/primary' has a corrupt index \(manifest references 1 missing data file\)\. Run: scrybe index -P demo -S primary --full/);

    const masked = await onServer();
    assert.deepEqual([masked.isError, masked.value], [true, { error: "internal error" }]);
    const events = await until(() => { const e = w.logged("health.corrupt").slice(before); return e.length > 0 && e; }, 15_000, "the announcement");
    assert.deepEqual(events.map((e) => [e.level, e.projectId, e.sourceId, e.detail.tableName, e.detail.reasons]), [["warn", "demo", "primary", tableOf(w), ["manifest_missing_data"]]]);
    assert.deepEqual(events[0].detail.details, details);
    for (const [f, bytes] of kept) writeFileSync(join(dir, f), bytes);
    assert.equal((await onServer()).isError, true, "the answer is kept");
    await w.killServer();
    assert.equal((await onServer()).isError, false);
  });

  test("an answer is kept for as long as SCRYBE_HEALTH_TTL_MS says", async () => {
    const dir = join(w.data, "lancedb", `${tableOf(w)}.lance`, "_versions");
    const kept = readdirSync(dir).map((f) => [f, readFileSync(join(dir, f))]);
    const restore = () => { for (const [f, bytes] of kept) writeFileSync(join(dir, f), bytes); };
    for (const [ttl, answers] of [["600000", true], ["1x", false]]) {
      const tools = stdioTools(w, { SCRYBE_HEALTH_TTL_MS: ttl });
      try {
        assert.ok(Array.isArray(await tools.call("search_code", {})));
        emptyManifests(w, tableOf(w));
        await sleep(50);
        const value = await tools.call("search_code", {});
        if (answers) assert.ok(Array.isArray(value), JSON.stringify(value).slice(0, 300));
        else assert.deepEqual(faultOf(value, "has an unreadable index", "schema_unreadable"), { error_message: "zero-byte manifest" });
        restore();
        assert.ok(Array.isArray(await tools.call("search_code", {})));
      } finally {
        tools.stop();
        restore();
      }
    }
  });
});

describe("a config.json with a fault", () => {
  let w;
  before(async () => {
    w = await makeWorld();
    await w.index("--full");
  });
  afterEach(() => w.killServer());
  after(() => w.stop());
  const refused = async (change, message) => {
    const file = join(w.data, "config.json");
    const good = readFileSync(file, "utf8");
    changeConfig(w, change);
    try {
      const indexed = await w.cli("index", "-P", "demo", "-S", "primary");
      assert.notEqual(indexed.status, 0);
      assert.ok((indexed.stderr + indexed.stdout).includes(message), indexed.stderr + indexed.stdout);
      const searched = await w.cli("search", "code", "-P", "demo", "widget");
      assert.equal(searched.status, 1);
      assert.ok((searched.stderr + searched.stdout).includes(message), searched.stderr + searched.stdout);
      const { base } = await startedServer(w);
      const res = await fetch(`${base}/mcp/rpc`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ id: 1, method: "status", params: {} }) });
      const status = (await res.json()).result;
      assert.deepEqual([status.config_present, status.config_error, status.config_error_message, status.code_model, status.api_key_present], [true, true, message, "", false]);
    } finally {
      writeFileSync(file, good);
    }
  };

  test("a model of the wrong kind for its slot is refused when indexing and searching, and status says so", () =>
    refused((c) => {
      c.embedding_presets.text = { provider: "voyage", model: "voyage-4", credentials: "k" };
      c.assignments.code_preset = "text";
    }, 'preset "text" uses model "voyage-4" with profile "text", but it is assigned to slot "code_preset" which requires profile "code"'));

  test("a preset that isn't there is named", () =>
    refused((c) => { c.assignments.code_preset = "gone"; }, 'embedding preset "gone" not found in config'));

  test("an unknown provider is named", () =>
    refused((c) => { c.embedding_presets.fake.provider = "nowhere"; }, 'unknown provider: "nowhere"'));

  for (const [what, change, message] of [
    ["a missing assignment", (c) => { delete c.assignments.text_preset; }, "config.json: assignments.text_preset missing"],
    ["a preset field of the wrong type, even in a preset nothing uses", (c) => { c.embedding_presets.spare = { provider: "custom", model: "m", max_input_tokens: "8" }; }, "config.json: embedding_presets.spare.max_input_tokens must be a number"],
    ["no schema version", (c) => { delete c.schema_version; }, "config.json: missing or non-numeric schema_version"],
  ]) test(`${what} is refused before anything else`, () => refused(change, message));
});

describe("ignore files are read like npm's ignore reads them", () => {
  test("braces are themselves, a byte-order mark goes, and bytes that aren't UTF-8 don't lose the file", async () => {
    const w = await makeWorld();
    try {
      const files = ["a.ts", "b.js", "a{b.ts", "ab.ts", "{x}.ts", "x.ts", "{y,z}.ts", "y.ts", "c.py", "deep/c.py", "deep/top.md", "out/o.ts", "deep/out/o.ts", "style.css", "skipme/s.ts", "q1.ts", "q{.ts", "caf.ts"];
      for (const f of files) {
        mkdirSync(join(w.repo, "src", f, ".."), { recursive: true });
        writeFileSync(join(w.repo, "src", f), `export const v = ${JSON.stringify(f)};\n`);
      }
      writeFileSync(join(w.repo, "top.md"), "# top\n");
      writeFileSync(join(w.repo, ".gitignore"), "*.{ts,js}\r\na{b.ts\r\n\\{x\\}.ts\r\n{y,z}.ts\r\n*.py\r\n/top.md\r\n/src/out/\r\nq[{].ts\r\n");
      writeFileSync(join(w.repo, ".scrybeignore"), Buffer.concat([Buffer.from("﻿*.css\n# caf"), Buffer.from([0xe9, 0x0a]), Buffer.from("skipme/\n")]));
      await w.index("--full");
      const hashes = JSON.parse(readFileSync(join(w.data, "hashes", `demo__primary__${w.main.replace(/\//g, "__")}.json`), "utf8"));
      const got = Object.keys(hashes).filter((k) => k !== "src/widget.ts").sort();
      assert.deepEqual(got, ["notes/ignored.ts", ...["a.ts", "ab.ts", "b.js", "caf.ts", "deep/out/o.ts", "deep/top.md", "q1.ts", "x.ts", "y.ts"].map((f) => `src/${f}`)].sort());
    } finally {
      await w.stop();
    }
  });
});

describe("what the file watcher reacts to", () => {
  let w, c;
  const jobs = () => w.logged("job.started").length;
  before(async () => {
    w = await makeWorld({ serverEnv: { SCRYBE_DAEMON_FS_DEBOUNCE_MS: "100", SCRYBE_DAEMON_GIT_DEBOUNCE_MS: "100", SCRYBE_DAEMON_COLD_MULTIPLIER: "1", SCRYBE_DAEMON_NO_FETCH: "1" } });
    mkdirSync(join(w.repo, ".github/workflows"), { recursive: true });
    mkdirSync(join(w.repo, "src/vendor"), { recursive: true });
    mkdirSync(join(w.repo, "vendor"));
    writeFileSync(join(w.repo, ".github/workflows/ci.ts"), "export function firstWorkflow() {}\n");
    writeFileSync(join(w.repo, ".scrybeignore"), "!.github/workflows/ci.ts\n");
    await w.index("--full");
    c = w.client();
    await c.hello();
    await c.rpc("tools/list");
    await sleep(1500);
  });
  after(() => w.stop());
  const indexed = (name) => until(async () => (await c.call("lookup_symbol", { project_id: "demo", symbol_name: name })).value?.length > 0, 30_000, `${name} to be indexed`);
  const starts = async (what, change) => {
    const before = jobs();
    change();
    await until(() => jobs() > before, 15_000, `a job for ${what}`);
    await until(async () => {
      const seen = jobs();
      await sleep(1500);
      const q = (await c.call("queue_status")).value;
      return jobs() === seen && q.running.length + q.queued.length === 0;
    }, 60_000, "the jobs to settle");
  };

  test("a dot-file starts a job", () => starts("a dot-file", () => writeFileSync(join(w.repo, ".eslintrc.json"), '{ "rules": {} }\n')));

  test("a file in a folder the indexer skips, unless it is at the top", async () => {
    await starts("a folder below the top", () => writeFileSync(join(w.repo, "src/vendor/v.ts"), "export const v = 1;\n"));
    const before = jobs();
    writeFileSync(join(w.repo, "vendor/v.ts"), "export const v = 1;\n");
    await sleep(2500);
    assert.equal(jobs(), before);
  });

  test("a force-included file in a dot-folder is indexed again when it changes", async () => {
    writeFileSync(join(w.repo, ".github/workflows/ci.ts"), "export function secondWorkflow() {}\n");
    await indexed("secondWorkflow");
  });

  test("a folder moved in is indexed, and watched afterwards", async () => {
    mkdirSync(join(w.dir, "outside/inner"), { recursive: true });
    writeFileSync(join(w.dir, "outside/inner/moved.ts"), "export function movedIn() {}\n");
    renameSync(join(w.dir, "outside"), join(w.repo, "src/arrived"));
    await indexed("movedIn");
    await sleep(500);
    writeFileSync(join(w.repo, "src/arrived/later.ts"), "export function savedInTheMovedFolder() {}\n");
    await indexed("savedInTheMovedFolder");
  });
});

describe("requests to the embedding endpoint", () => {
  test("no proxy from the environment is used", async () => {
    const dead = "http://127.0.0.1:9";
    const w = await makeWorld({ serverEnv: { HTTP_PROXY: dead, http_proxy: dead, HTTPS_PROXY: dead, https_proxy: dead, ALL_PROXY: dead, all_proxy: dead, NO_PROXY: "", no_proxy: "", NODE_USE_ENV_PROXY: "" } });
    try {
      await w.index("--full");
      const c = w.client();
      await c.hello();
      assert.equal((await c.call("search_code", { project_id: "demo", query: "widget" })).isError, false);
    } finally {
      await w.stop();
    }
  });

  test("the account named in the environment goes along, and a retry date is waited for", async () => {
    const fake = await fakeEmbedder({ refuse: (n) => (n === 1 ? { code: 429, headers: { "Retry-After": new Date(Date.now() + 4000).toUTCString() } } : null) });
    const w = await makeWorld({ embedder: fake, serverEnv: { OPENAI_ORG_ID: " org-contract ", OPENAI_PROJECT_ID: "proj-contract" } });
    try {
      await w.index("--full");
      assert.deepEqual([...new Set(fake.log.map((l) => `${l.organization}|${l.project}`))], ["org-contract|proj-contract"]);
      const gap = fake.log[1].at - fake.log[0].at;
      assert.ok(gap > 2000 && gap < 8000, `waited ${gap} ms`);
    } finally {
      await w.stop();
      fake.close();
    }
  });

  test("batch sizes are read from the front of the value", async () => {
    const w = await makeWorld({ serverEnv: { SCRYBE_EMBED_BATCH_SIZE: " 1abc" } });
    try {
      await w.index("--full");
      assert.deepEqual([...new Set(w.fake.log.map((l) => l.n))], [1]);
    } finally {
      await w.stop();
    }
  });

  test("a certificate authority named by NODE_EXTRA_CA_CERTS is trusted, and no other", async (t) => {
    const dir = mkdtempSync(join(tmpdir(), "scrybe-ca-"));
    const at = (f) => join(dir, f);
    const openssl = (...args) => execFileSync("openssl", args, { stdio: "ignore" });
    try {
      writeFileSync(at("ca.cnf"), "[req]\ndistinguished_name=dn\nx509_extensions=v3\n[dn]\n[v3]\nbasicConstraints=critical,CA:TRUE\nkeyUsage=critical,keyCertSign\nsubjectKeyIdentifier=hash\n");
      writeFileSync(at("leaf.ext"), "basicConstraints=CA:FALSE\nsubjectAltName=IP:127.0.0.1\nextendedKeyUsage=serverAuth\n");
      const key = ["-newkey", "ec", "-pkeyopt", "ec_paramgen_curve:P-256", "-nodes"];
      openssl("req", "-x509", ...key, "-keyout", at("ca.key"), "-out", at("ca.pem"), "-days", "2", "-subj", "/CN=contract-ca", "-config", at("ca.cnf"));
      openssl("req", ...key, "-keyout", at("leaf.key"), "-out", at("leaf.csr"), "-subj", "/CN=contract-leaf", "-config", at("ca.cnf"));
      openssl("x509", "-req", "-in", at("leaf.csr"), "-CA", at("ca.pem"), "-CAkey", at("ca.key"), "-CAcreateserial", "-days", "2", "-extfile", at("leaf.ext"), "-out", at("leaf.pem"));
    } catch {
      rmSync(dir, { recursive: true, force: true });
      return t.skip("no usable openssl on this host");
    }
    const fake = await fakeEmbedder({ tls: { key: readFileSync(at("leaf.key")), cert: readFileSync(at("leaf.pem")) } });
    const w = await makeWorld({ embedder: fake });
    try {
      const run = (extra) => w.cliWith(extra, "index", "-P", "demo", "-S", "primary", "--full");
      for (const extra of [{ NODE_EXTRA_CA_CERTS: "" }, { NODE_EXTRA_CA_CERTS: at("missing.pem") }, { NODE_EXTRA_CA_CERTS: at("leaf.ext") }]) {
        assert.notEqual((await run(extra)).status, 0);
      }
      assert.equal(fake.log.length, 0);
      const r = await run({ NODE_EXTRA_CA_CERTS: at("ca.pem") });
      assert.equal(r.status, 0, r.stderr + r.stdout);
      assert.ok(fake.log.length > 0);
    } finally {
      await w.stop();
      fake.close();
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("a NODE_EXTRA_CA_CERTS file that isn't there stops nothing", async () => {
    const w = await makeWorld({ serverEnv: { NODE_EXTRA_CA_CERTS: join(tmpdir(), "scrybe-no-such-file.pem") } });
    try {
      await w.index("--full");
      assert.ok(w.fake.log.length > 0);
    } finally {
      await w.stop();
    }
  });
});

describe("the .env file in the data dir", () => {
  test("quotes are part of a value, odd bytes and nameless lines are passed over, and the environment wins", async () => {
    const w = await makeWorld({ serverEnv: { CONTRACT_ENV_WINS: "from the environment" } });
    try {
      const write = (...parts) => writeFileSync(join(w.data, ".env"), Buffer.concat(parts.map((p) => Buffer.from(p))));
      const keySent = async (name) => {
        changeConfig(w, (c) => { c.embedding_presets.fake.credentials = `\${${name}}`; });
        const n = w.fake.log.length;
        await w.index("--full");
        return w.fake.log[n].auth;
      };
      write("﻿CONTRACT_DOT_A=first\r\n# caf", [0xe9], "\r\n=nameless\r\n  CONTRACT_DOT_B = \"two words\" \r\nCONTRACT_DOT_C='single'\r\nCONTRACT_DOT_D=a=b#c\r\nCONTRACT_ENV_WINS=no\r\nCONTRACT_DOT_D=second\r\n");
      assert.equal(await keySent("CONTRACT_DOT_A"), "Bearer first");
      assert.equal(await keySent("CONTRACT_DOT_B"), 'Bearer "two words"');
      assert.equal(await keySent("CONTRACT_DOT_C"), "Bearer 'single'");
      assert.equal(await keySent("CONTRACT_DOT_D"), "Bearer a=b#c");
      assert.equal(await keySent("CONTRACT_ENV_WINS"), "Bearer from the environment");
    } finally {
      await w.stop();
    }
  });
});

describe("how long old table versions are kept", () => {
  test("SCRYBE_LANCE_GRACE_MS decides", async () => {
    const manifests = async (extra) => {
      const w = await makeWorld({ serverEnv: extra });
      try {
        await w.index("--full");
        return readdirSync(join(w.data, "lancedb", `${tableOf(w)}.lance`, "_versions")).filter((f) => f.endsWith(".manifest")).length;
      } finally {
        await w.stop();
      }
    };
    const usual = await manifests({});
    const none = await manifests({ SCRYBE_LANCE_GRACE_MS: "0" });
    const odd = await manifests({ SCRYBE_LANCE_GRACE_MS: "-5" });
    assert.ok(none < usual, `${none} against ${usual}`);
    assert.equal(odd, usual);
  });
});

describe("the indexer's records in the server log", () => {
  const fieldsOf = (r) => Object.keys(r);
  const stamp = ["ts", "pid", "event", "projectId", "sourceId", "branch"];

  test("a run says what it found and what it did, and with SCRYBE_DEBUG_INDEXER each batch too", async () => {
    const w = await makeWorld();
    try {
      await w.index("--full");
      const [scan] = w.logged("indexer.scan.completed"), [job] = w.logged("indexer.job.summary");
      assert.deepEqual(fieldsOf(scan), [...stamp, "mode", "files_total", "files_to_reindex", "files_to_remove"]);
      assert.deepEqual([scan.projectId, scan.sourceId, scan.branch, scan.mode, scan.files_total, scan.files_to_reindex, scan.files_to_remove], ["demo", "primary", w.main, "full", 2, 2, 0]);
      assert.deepEqual(fieldsOf(job), [...stamp, "mode", "files_scanned", "files_reindexed", "chunks_prepared", "chunks_persisted", "total_ms"]);
      assert.deepEqual([job.files_scanned, job.files_reindexed, job.chunks_persisted], [2, 2, job.chunks_prepared]);
      for (const quiet of ["indexer.write.completed", "indexer.embed.batch", "indexer.flush.intra_batch_dedup", "indexer.phase1"]) assert.equal(w.logged(quiet).length, 0, quiet);

      rmSync(join(w.repo, "src/gadget.py"));
      writeFileSync(join(w.repo, "src/extra.ts"), "export function extraOne() { return 1; }\n");
      const r = await w.cliWith({ SCRYBE_DEBUG_INDEXER: "1" }, "index", "-P", "demo", "-S", "primary");
      assert.equal(r.status, 0, r.stderr);
      const [write] = w.logged("indexer.write.completed"), [batch] = w.logged("indexer.embed.batch");
      assert.deepEqual(fieldsOf(write), [...stamp, "chunks_in_batch", "chunks_actually_added", "cumulative_chunks_persisted"]);
      assert.deepEqual([write.chunks_in_batch, write.chunks_actually_added, write.cumulative_chunks_persisted], [1, 1, 1]);
      assert.deepEqual(fieldsOf(batch), [...stamp, "batch_size", "batch_ms", "cumulative_chunks_embedded"]);
      assert.deepEqual([batch.batch_size, batch.cumulative_chunks_embedded], [1, 1]);
      const [phase1] = w.logged("indexer.phase1"), [gone] = w.logged("indexer.applyFile"), [result] = w.logged("indexer.result");
      const debug = ["ts", "debug", "event", "projectId", "sourceId", "branch"];
      assert.deepEqual(fieldsOf(phase1), [...debug, "mode", "oldHashesCount", "currentSourcesCount", "toRemove", "toReindexCount"]);
      assert.deepEqual([phase1.oldHashesCount, phase1.currentSourcesCount, phase1.toRemove, phase1.toReindexCount], [2, 2, ["src/gadget.py"], 1]);
      assert.deepEqual([...fieldsOf(gone), gone.path, gone.kind], [...debug, "path", "kind", "src/gadget.py", "removed"]);
      assert.deepEqual(fieldsOf(result), [...debug, "mode", "chunksIndexed", "filesScanned", "filesReindexed", "filesRemoved"]);
      assert.deepEqual([result.chunksIndexed, result.filesScanned, result.filesReindexed, result.filesRemoved], [1, 2, 1, 1]);
    } finally {
      await w.stop();
    }
  });
});

describe("SCRYBE_DEBUG_SEARCH", () => {
  test("names a branch that isn't indexed on the server's standard output", async () => {
    const w = await makeWorld();
    let server;
    try {
      await w.index("--full");
      server = spawn(SERVER[0], SERVER.slice(1), { env: { ...w.env, SCRYBE_DEBUG_SEARCH: "1" }, stdio: ["ignore", "pipe", "ignore"], windowsHide: true });
      let out = "";
      server.stdout.on("data", (d) => { out += d; });
      await until(() => w.health(), 20_000, "the server");
      const c = w.client();
      await c.hello();
      const r = await c.call("search_code", { project_id: "demo", query: "widget", branch: "nowhere" });
      assert.deepEqual([r.isError, r.value], [false, []], r.text);
      await until(() => out.includes('[scrybe:search] branch "nowhere" unresolved for source primary (project demo) — returning []'), 5000, "the line");
    } finally {
      server?.kill("SIGKILL");
      await w.stop();
    }
  });
});

/** A server of this run's own, with what it printed. `exited` settles when it has gone. */
const ownServer = async (w, extraEnv = {}) => {
  const p = spawn(SERVER[0], SERVER.slice(1), { env: { ...w.env, ...extraEnv }, stdio: ["ignore", "pipe", "pipe"], windowsHide: true });
  const server = { p, out: "", err: "", gone: false };
  p.stdout.on("data", (d) => { server.out += d; });
  p.stderr.on("data", (d) => { server.err += d; });
  server.exited = new Promise((resolve) => p.on("exit", (code) => { server.gone = true; resolve(code); }));
  await until(() => w.health(), 30_000, "the server");
  server.port = w.pidfile().port;
  server.base = `http://127.0.0.1:${server.port}`;
  server.rpc = async (method, params = {}, headers = {}) => (await rawRequest(server.port, "POST", "/mcp/rpc", [JSON.stringify({ id: 1, method, params })], headers)).body;
  server.status = async () => (await fetch(`${server.base}/status`)).json();
  server.kill = async () => { p.kill("SIGKILL"); await server.exited; };
  return server;
};

const holdable = async () => {
  const fake = await fakeEmbedder();
  let release = () => {};
  return {
    fake,
    hold: () => { fake.gate.hold = new Promise((resolve) => { release = () => { fake.gate.hold = null; resolve(); }; }); },
    release: () => release(),
    waiting: (n) => until(() => fake.gate.waiting >= n, 20_000, `${n} held embedding request(s)`),
  };
};

describe("the opt-in MCP endpoint", () => {
  let w, server;
  const BOTH = { Accept: "application/json, text/event-stream" };
  const post = (message, headers = {}) => rawRequest(server.port, "POST", "/mcp", [JSON.stringify(message)], { ...BOTH, ...headers });
  const request = (method, params, id = 1) => ({ jsonrpc: "2.0", id, method, ...(params === undefined ? {} : { params }) });
  const hello = { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "contract", version: "1" } };
  const ok = (result, id = 1) => ({ result, jsonrpc: "2.0", id });
  const refused = (code, message) => ({ jsonrpc: "2.0", error: { code, message }, id: null });
  const failed = (text) => ok({ content: [{ type: "text", text: JSON.stringify({ error: text }, null, 2) }], isError: true });
  const clients = async () => (await server.status()).clientCount;
  before(async () => {
    w = await makeWorld();
    w.env.SCRYBE_DAEMON_MCP_HTTP = "true";
    await w.index("--full");
    server = await ownServer(w);
  });
  after(async () => { await server?.kill(); await w.stop(); });

  test("counts as a client once a request reaches it, and not before", async () => {
    for (const method of ["GET", "DELETE"]) {
      const r = await rawRequest(server.port, method, "/mcp", [], BOTH);
      assert.deepEqual([r.status, r.body], [405, refused(-32000, "Method not allowed.")], method);
    }
    assert.equal(await clients(), 0);
    assert.deepEqual((await post(request("ping"))).body, ok({}));
    assert.equal(await clients(), 1);
    assert.equal((await rawRequest(server.port, "PUT", "/mcp", ["{}"], BOTH)).status, 405);
  });

  test("settles the protocol version", async () => {
    const versionFor = async (asked) => (await post(request("initialize", { ...hello, protocolVersion: asked }))).body.result;
    const known = await versionFor("2025-06-18");
    assert.deepEqual([known.protocolVersion, known.capabilities, known.serverInfo.name], ["2025-06-18", { tools: {} }, "scrybe"]);
    assert.equal((await versionFor("1999-01-01")).protocolVersion, "2025-11-25");
    const odd = await post(request("ping"), { "Mcp-Protocol-Version": "1999" });
    assert.deepEqual([odd.status, odd.body], [400, refused(-32000, "Bad Request: Unsupported protocol version: 1999 (supported versions: 2025-11-25, 2025-06-18, 2025-03-26, 2024-11-05, 2024-10-07)")]);
    assert.equal((await post(request("initialize", hello), { "Mcp-Protocol-Version": "1999" })).status, 200);
    assert.equal((await post(request("ping"), { "Mcp-Protocol-Version": "2024-11-05" })).status, 200);
  });

  test("offers the same tools as the manifest", async () => {
    const manifest = await (await fetch(`${server.base}/mcp/manifest`)).json();
    const listed = (await post(request("tools/list", {}, "list"))).body;
    assert.deepEqual([listed.id, listed.result.tools], ["list", manifest.tools]);
    assert.ok(listed.result.tools.length > 20);
  });

  test("runs a tool, checks its arguments and masks an internal fault", async () => {
    const call = async (name, args) => (await post(request("tools/call", { name, ...(args === undefined ? {} : { arguments: args }) }))).body;
    const listed = await call("list_projects");
    assert.deepEqual(Object.keys(listed.result), ["content"]);
    assert.equal(JSON.parse(listed.result.content[0].text)[0].id, "demo");
    const hits = await call("search_code", { project_id: "demo", query: "frobnicate widget" });
    assert.match(hits.result.content[0].text, /^\[\n  \{\n/);
    assert.deepEqual(await call("nope", {}), failed("method not found: nope"));
    assert.deepEqual(await call("search_code", { project_ids: ["demo"] }), failed("invalid params for search_code: unknown key 'project_ids' (did you mean 'project_id'?)"));
    assert.deepEqual(await call("search_code", { project_id: "gone", query: "x" }), failed("Project 'gone' not found"));
    assert.deepEqual(await call("reindex_project", { project_id: "gone" }), failed("internal error"));
    const issue = (expected, path, received) => [{ expected, code: "invalid_type", path, message: `Invalid input: expected ${expected}, received ${received}` }];
    for (const [params, problem] of [[{}, issue("string", ["params", "name"], "undefined")], [undefined, issue("object", ["params"], "undefined")], [{ name: "list_projects", arguments: [] }, issue("record", ["params", "arguments"], "array")]]) {
      const r = (await post(request("tools/call", params))).body;
      assert.deepEqual([r.error.code, JSON.parse(r.error.message)], [-32603, problem]);
    }
    assert.deepEqual((await post(request("resources/list"))).body, { jsonrpc: "2.0", id: 1, error: { code: -32601, message: "Method not found" } });
  });

  test("answers requests, stays silent on the rest and refuses what isn't a message", async () => {
    const note = { jsonrpc: "2.0", method: "notifications/initialized" };
    for (const quiet of [note, [note], [], { jsonrpc: "2.0", id: 1, result: {} }]) {
      const r = await post(quiet);
      assert.deepEqual([r.status, r.text], [202, ""], JSON.stringify(quiet));
    }
    assert.deepEqual((await post([note, request("ping", {}, 7)])).body, ok({}, 7));
    assert.deepEqual((await post([request("ping", {}, 1), request("ping", {}, "b")])).body, [ok({}, 1), ok({}, "b")]);
    const alone = await post([request("initialize", hello), request("ping", {}, 2)]);
    assert.deepEqual([alone.status, alone.body], [400, refused(-32600, "Invalid Request: Only one initialization request is allowed")]);
    for (const bad of [5, null, [5], { id: 1, method: "ping" }, { ...request("ping"), id: null }, { ...request("ping"), id: 1.5 }, { ...request("ping"), extra: 1 }, request("ping", [])]) {
      const r = await post(bad);
      assert.deepEqual([r.status, r.body], [400, refused(-32700, "Parse error: Invalid JSON-RPC message")], JSON.stringify(bad));
    }
    const json = await post(request("ping"), { Accept: "application/json" });
    assert.deepEqual([json.status, json.body], [406, refused(-32000, "Not Acceptable: Client must accept both application/json and text/event-stream")]);
    const text = await post(request("ping"), { "Content-Type": "text/plain" });
    assert.deepEqual([text.status, text.body], [415, refused(-32000, "Unsupported Media Type: Content-Type must be application/json")]);
  });
});

describe("a server finishing its work", () => {
  let w, held, server, jobsBefore;
  const jobCount = async () => (await server.rpc("list_jobs")).result.count;
  before(async () => {
    held = await holdable();
    w = await makeWorld({ embedder: held.fake, serverEnv: { SCRYBE_DAEMON_FS_DEBOUNCE_MS: "100", SCRYBE_DAEMON_GIT_DEBOUNCE_MS: "100", SCRYBE_DAEMON_COLD_MULTIPLIER: "1", SCRYBE_DAEMON_MAX_CONCURRENT: "1" } });
    await w.index("--full");
    server = await ownServer(w);
    await until(async () => (await server.status()).projects[0].watcherHealthy, 20_000, "the watcher");
    held.hold();
    await server.rpc("reindex_source", { project_id: "demo", source_id: "primary", mode: "full" });
    await held.waiting(1);
    jobsBefore = await jobCount();
    assert.equal((await rawRequest(server.port, "POST", "/shutdown", [])).status, 200);
    await until(async () => (await w.health())?.draining, 10_000, "the drain");
  });
  after(async () => { held.release(); await server?.kill(); await w.stop(); held.fake.close(); });

  test("answers reads, and refuses work and pausing", async () => {
    for (const path of ["/kick", "/gc", "/pause", "/resume"]) {
      const r = await rawRequest(server.port, "POST", path, ["{}"]);
      assert.deepEqual([r.status, r.body], [503, { error: "daemon is shutting down — not accepting new work", draining: true }], path);
    }
    const status = await server.status();
    assert.equal(status.draining, true);
    assert.equal((await server.rpc("list_projects")).result[0].id, "demo");
  });

  test("has stopped watching", async () => {
    const [p] = await until(async () => { const { projects } = await server.status(); return !projects[0].watcherHealthy && projects; }, 5000, "the watchers to stop");
    assert.deepEqual([p.gitWatcherHealthy, p.currentBranch], [false, null]);
    writeFileSync(join(w.repo, "src/late.ts"), "export function savedTooLate() { return 1; }\n");
    await sleep(1500);
    assert.equal(await jobCount(), jobsBefore);
    rmSync(join(w.repo, "src/late.ts"));
  });

  test("refuses the tools that would queue work, and says why in its log", async () => {
    const calls = [["reindex_project", { project_id: "demo" }], ["reindex_source", { project_id: "demo", source_id: "primary" }], ["gc", {}], ["index_ephemeral", { project_id: "demo", branch: "side" }], ["add_source", { project_id: "demo", source_id: "second", source_type: "code", root_path: w.repo }]];
    const answers = await Promise.all(calls.map(([name, args]) => server.rpc(name, args)));
    answers.forEach((a, i) => assert.deepEqual(a, { id: 1, error: { code: -32603, message: "internal error" } }, calls[i][0]));
    assert.equal(await jobCount(), jobsBefore);
    const [project] = JSON.parse(readFileSync(join(w.data, "projects.json"), "utf8"));
    assert.deepEqual(project.sources.map((s) => s.source_id), ["primary"], "the source is taken back out");
    for (const [name] of calls) {
      const [span] = w.logged("activity-span").filter((r) => r.method === name && r.outcome === "error");
      assert.equal(span?.error, "The scrybe daemon is shutting down (finishing in-flight work) and is not accepting new jobs.?Retry in a moment — a replacement daemon starts on the next call.", name);
    }
  });

  test("leaves once the work is done", async () => {
    held.release();
    assert.equal(await Promise.race([server.exited, sleep(20_000).then(() => "still there")]), 0);
    assert.equal(w.pidfile(), null);
  });
});

describe("a signal to a server already leaving", { skip: process.platform === "win32" ? "no SIGTERM on Windows" : false }, () => {
  test("makes it leave at once, and is recorded", async () => {
    const held = await holdable();
    const w = await makeWorld({ embedder: held.fake });
    let server;
    try {
      await w.index("--full");
      server = await ownServer(w);
      held.hold();
      await server.rpc("reindex_source", { project_id: "demo", source_id: "primary", mode: "full" });
      await held.waiting(1);
      await rawRequest(server.port, "POST", "/shutdown", []);
      await until(async () => (await w.health())?.draining, 10_000, "the drain");
      server.p.kill("SIGTERM");
      assert.equal(await Promise.race([server.exited, sleep(10_000).then(() => "still there")]), 0);
      assert.equal(w.pidfile(), null);
      const [r] = w.logged("daemon.shutdown.escalated");
      assert.deepEqual([Object.keys(r), r.level, r.signal], [["ts", "pid", "level", "event", "signal"], "warn", "SIGTERM"]);
    } finally {
      held.release();
      await server?.kill();
      await w.stop();
      held.fake.close();
    }
  });
});

describe("a request still open when the server leaves", () => {
  test("gets its answer, and an event stream just ends", async () => {
    const held = await holdable();
    const w = await makeWorld({ embedder: held.fake });
    let server;
    try {
      await w.index("--full");
      server = await ownServer(w);
      const stream = (await fetch(`${server.base}/events`)).body.getReader();
      const ended = (async () => { while (!(await stream.read()).done) { /* events */ } })();
      held.hold();
      const search = server.rpc("search_code", { project_id: "demo", query: "frobnicate widget" });
      await held.waiting(1);
      await rawRequest(server.port, "POST", "/shutdown", []);
      assert.equal(await Promise.race([ended.then(() => "ended"), sleep(10_000)]), "ended");
      await sleep(500);
      assert.equal(server.gone, false, "it waits for the search");
      held.release();
      const answer = await search;
      assert.ok(Array.isArray(answer.result) && answer.result.length > 0, JSON.stringify(answer));
      assert.equal(await Promise.race([server.exited, sleep(10_000).then(() => "still there")]), 0);
    } finally {
      held.release();
      await server?.kill();
      await w.stop();
      held.fake.close();
    }
  });
});

describe("the state word", () => {
  test("follows activity and the last thing set, and only activity is announced", async () => {
    const w = await makeWorld({ serverEnv: { SCRYBE_DAEMON_FS_DEBOUNCE_MS: "100", SCRYBE_DAEMON_COLD_MULTIPLIER: "1", SCRYBE_DAEMON_HOT_MS: "1500" } });
    let server;
    try {
      await w.index("--full");
      server = await ownServer(w);
      await until(async () => (await server.status()).projects[0].watcherHealthy, 20_000, "the watcher");
      const state = async () => (await server.status()).state;
      const announced = async () => (await server.status()).recentEvents.filter((e) => e.event === "state.changed").map((e) => e.detail.state);
      // macOS may report the repository's own creation late.
      await sleep(2000);
      await until(async () => (await state()) === "cold", 15_000, "a quiet start");
      const earlier = (await announced()).length;
      assert.equal((await post(server.base, "/pause")).state, "paused");
      assert.equal(await state(), "paused");
      const heard = [];
      const stream = (await fetch(`${server.base}/events`)).body;
      (async () => { for await (const piece of stream) heard.push(Buffer.from(piece).toString("utf8")); })().catch(() => {});
      writeFileSync(join(w.repo, "src/active.ts"), "export function wakesTheServer() { return 1; }\n");
      await until(async () => (await announced())[earlier] === "hot", 10_000, "hot");
      await until(async () => (await announced()).at(-1) === "cold", 15_000, "cold");
      assert.equal(await state(), "cold", "the pause is forgotten");
      const line = heard.join("").split("\n").find((l) => l.includes('"state.changed"'));
      assert.deepEqual(Object.keys(JSON.parse(line.slice("data: ".length))), ["ts", "level", "event", "detail"]);
      // A late report of the change above must not count as a new one.
      await until(async () => { const n = (await announced()).length; await sleep(3000); return (await announced()).length === n && (await state()) === "cold"; }, 40_000, "quiet");
      const before = await announced();
      assert.equal((await post(server.base, "/resume")).state, "hot");
      await sleep(2500);
      assert.deepEqual([await state(), await announced()], ["hot", before], "a resume is not activity");
    } finally {
      await server?.kill();
      await w.stop();
    }
  });
});

describe("the server's own log file", () => {
  const started = (port) => new RegExp(`^\\d{4}-\\d\\d-\\d\\dT[\\d:.]+Z \\[scrybe daemon\\] started pid=\\d+ port=${port} `, "m");
  test("holds its lines, is set aside when it is too big, and moves with SCRYBE_DAEMON_LOG_PATH", async () => {
    const w = await makeWorld();
    const file = (suffix = "") => readFileSync(join(w.data, "logs", `daemon.log${suffix}`), "utf8");
    let server;
    try {
      await w.cli("projects");
      server = await ownServer(w);
      const first = server.port;
      await until(() => started(first).test(file()), 5000, "the line");
      await until(() => started(first).test(server.err), 5000, "the line on standard error");
      assert.equal((await server.rpc("reindex_project", { project_id: "gone" })).error.message, "internal error");
      // Today's build names the cause on standard output, which a background server doesn't have.
      if (BUILD === "rust") assert.match(file(), /Z \[mcp-rpc\] client=anon method=reindex_project → error: Project 'gone' not found$/m);
      await server.kill();
      rmSync(join(w.data, "daemon.pid"), { force: true });
      server = await ownServer(w, { SCRYBE_DAEMON_LOG_MAX_BYTES: "10", SCRYBE_DAEMON_LOG_BACKUPS: "2" });
      await until(() => started(server.port).test(file()), 5000, "the new line");
      assert.match(file(".1"), started(first));
      assert.equal(file().match(/started pid=/g).length, 1);
      await server.kill();
      rmSync(join(w.data, "daemon.pid"), { force: true });
      const own = join(w.dir, "own.log");
      server = await ownServer(w, { SCRYBE_DAEMON_LOG_PATH: own });
      await until(() => started(server.port).test(readFileSync(own, "utf8")), 5000, "the line in the named file");
      assert.equal(file().match(/started pid=/g).length, 1);
    } finally {
      await server?.kill();
      await w.stop();
    }
  });
});

describe("call and job records in the server log", () => {
  const readings = ["startRssBytes", "peakRssBytes", "endRssBytes"];
  const stamp = ["ts", "pid", "event", "level"];
  const measured = (r) => {
    if (process.platform !== "linux") return;
    assert.ok(r.startRssBytes > 0 && r.peakRssBytes >= r.startRssBytes && r.peakRssBytes >= r.endRssBytes, JSON.stringify(r));
  };

  test("a call and a job each leave a span, and the call a line with the caller's name", async () => {
    const w = await makeWorld();
    let server;
    try {
      await w.index("--full");
      server = await ownServer(w);
      await server.rpc("list_projects", {}, { "X-Scrybe-Client-Id": "host:1:2" });
      await server.rpc("search_code", { project_ids: 1 });
      await server.rpc("nope");
      const spans = (type) => w.logged("activity-span").filter((r) => r.spanType === type);
      await until(() => spans("mcp-call").length === 2, 5000, "the spans");
      const [good, bad] = spans("mcp-call");
      const call = [...stamp, "spanType", "method", "clientId", "durationMs", "outcome", ...readings];
      assert.deepEqual([Object.keys(good), good.method, good.clientId, good.outcome, good.level], [call, "list_projects", "host:1:2", "ok", "info"]);
      assert.deepEqual([Object.keys(bad), bad.clientId, bad.outcome], [[...call, "error"], "anon", "error"]);
      assert.equal(bad.error, "invalid params for search_code: unknown key 'project_ids' (did you mean 'project_id'?)");
      measured(good);
      for (const line of ["[mcp-rpc] client=host:1:2 method=list_projects", "[mcp-rpc] client=anon method=search_code", `[mcp-rpc] client=anon method=search_code → error: ${bad.error}`, "[mcp-rpc] client=anon method=nope → method not found"]) {
        await until(() => server.out.split("\n").includes(line), 5000, line);
      }
      const { job_id } = (await server.rpc("reindex_project", { project_id: "demo" })).result;
      const [job] = await until(() => spans("reindex").length > 0 && spans("reindex"), 20_000, "the job's span");
      assert.deepEqual(Object.keys(job), [...stamp, "spanType", "projectId", "sourceId", "jobId", "mode", "durationMs", "outcome", ...readings, "provider"]);
      assert.deepEqual([job.projectId, job.sourceId, job.jobId, job.mode, job.outcome, job.provider], ["demo", null, job_id, "incremental", "ok", "api"]);
      measured(job);
    } finally {
      await server?.kill();
      await w.stop();
    }
  });

  test("a job turned away by a full queue is recorded", async () => {
    const held = await holdable();
    const w = await makeWorld({ embedder: held.fake, serverEnv: { SCRYBE_DAEMON_MAX_QUEUE_DEPTH: "1" } });
    let server;
    try {
      await w.index("--full");
      server = await ownServer(w);
      held.hold();
      await server.rpc("reindex_source", { project_id: "demo", source_id: "primary", mode: "full" });
      await held.waiting(1);
      const kick = async (body) => (await rawRequest(server.port, "POST", "/kick", [JSON.stringify(body)])).body.jobs[0].status;
      assert.equal(await kick({ projectId: "demo" }), "queued");
      assert.equal(await kick({ projectId: "demo", sourceId: "primary" }), "rejected");
      const [r] = w.logged("queue.backpressure");
      assert.deepEqual([Object.keys(r), r.level], [[...stamp, "detail"], "warn"]);
      assert.deepEqual(r.detail, { currentDepth: 1, maxDepth: 1, projectId: "demo", sourceId: "primary", type: "reindex" });
    } finally {
      held.release();
      await server?.kill();
      await w.stop();
      held.fake.close();
    }
  });

  test("a port that is taken, and the one tried next, are recorded", async () => {
    const w = await makeWorld();
    const taken = createServer((s) => s.destroy());
    let server;
    try {
      await w.cli("projects");
      // Whatever already holds it will do just as well.
      await new Promise((r) => { taken.on("error", r); taken.listen(58451, "127.0.0.1", r); });
      server = await ownServer(w);
      const [r] = w.logged("daemon.bind.fallback");
      assert.deepEqual([Object.keys(r), r.level], [["ts", "pid", "level", "event", "detail"], "warn"]);
      assert.deepEqual([r.detail.refusedPort, r.detail.nextPort], [58451, "ephemeral"]);
      assert.match(r.detail.code, /^E(ADDRINUSE|ACCES)$/);
    } finally {
      await server?.kill();
      taken.close();
      await w.stop();
    }
  });
});

describe("one source of a running job, and a run over every project", () => {
  test("a waiting source can be cancelled alone, and a finished run says where the projects stand", async () => {
    const held = await holdable();
    const w = await makeWorld({ embedder: held.fake });
    let server;
    try {
      await w.index("--full");
      const list = JSON.parse(readFileSync(join(w.data, "projects.json"), "utf8"));
      list[0].sources.push({ source_id: "second", source_config: { type: "code", root_path: w.repo, languages: [] } });
      writeFileSync(join(w.data, "projects.json"), JSON.stringify(list));
      writeFileSync(join(w.repo, "src/changed.ts"), "export function somethingToEmbed() { return 1; }\n");
      server = await ownServer(w);
      held.hold();
      const { job_id } = (await server.rpc("reindex_project", { project_id: "demo" })).result;
      await held.waiting(1);
      const cancel = async (source_id) => (await server.rpc("cancel_reindex", { job_id, source_id })).result;
      assert.deepEqual(await cancel("second"), { job_id, cancelled: true });
      assert.deepEqual(await cancel("second"), { job_id, cancelled: false });
      assert.deepEqual(await cancel("nope"), { job_id, cancelled: false });
      const status = async (id) => (await server.rpc("reindex_status", { job_id: id })).result;
      const ended = (id) => until(async () => { const s = await status(id); return s.status !== "running" && s; }, 30_000, "the job");
      const running = await status(job_id);
      assert.deepEqual(running.tasks.map((t) => t.status), ["running", "cancelled"]);
      assert.ok(running.tasks[1].finished_at > 0 && running.tasks[1].started_at === null);
      held.release();
      const done = await ended(job_id);
      assert.deepEqual([done.status, done.tasks.map((t) => t.status)], ["cancelled", ["done", "cancelled"]]);
      assert.equal(JSON.parse(readFileSync(join(w.data, "projects.json"), "utf8"))[0].sources[1].last_indexed, undefined, "it never ran");

      const all = await ended((await server.rpc("reindex_all")).result.job_id);
      assert.equal(all.status, "done", JSON.stringify(all));
      assert.deepEqual(all.projects.map((p) => [Object.keys(p), p.project_id, p.sources.map((s) => s.source_id)]), [[["project_id", "sources"], "demo", ["primary", "second"]]]);
      for (const s of all.projects[0].sources) assert.ok(Date.parse(s.last_indexed) > 0, JSON.stringify(s));
      assert.equal("projects" in done, false);
    } finally {
      held.release();
      await server?.kill();
      await w.stop();
      held.fake.close();
    }
  });
});

describe("SCRYBE_DEBUG_FETCH_POLLER", () => {
  test("announces every round of the fetch poller", async () => {
    const w = await makeWorld({ pinned: ["side"], withOrigin: true, serverEnv: { SCRYBE_DAEMON_NO_FETCH: "", SCRYBE_DEBUG_FETCH_POLLER: "1" } });
    let server;
    try {
      await w.index("--full");
      server = await ownServer(w);
      const tick = await until(async () => {
        const { recentEvents } = await server.status();
        return recentEvents.find((e) => e.event === "watcher.event" && e.detail?.phase === "fetch-poller.tick");
      }, 20_000, "the round");
      assert.deepEqual([tick.level, tick.projectId, tick.detail], ["info", "demo", { phase: "fetch-poller.tick", branchesPolled: 1, deltasFound: 1, outOfBandDetected: 0 }]);
    } finally {
      await server?.kill();
      await w.stop();
    }
  });
});

describe("the tiny client and a server of another version", () => {
  let w, fake, port, version, calls;
  const own = async () => (await w.client({ extraEnv: { SCRYBE_NO_AUTO_DAEMON: "1" } }).hello()).result.serverInfo.version;
  const pidfile = (pid) => writeFileSync(join(w.data, "daemon.pid"), JSON.stringify({ pid, port }));
  const client = (opts = {}) => w.client({ extraEnv: { SCRYBE_NO_AUTO_DAEMON: "1", SCRYBE_MCP_LISTCHANGED_POLL_INTERVAL_MS: "100" }, ...opts });
  before(async () => {
    w = await makeWorld();
    calls = 0;
    fake = createHttpServer((req, res) => {
      req.resume();
      const answer = (body) => { res.writeHead(200, { "Content-Type": "application/json" }); res.end(JSON.stringify(body)); };
      if (req.url === "/health") return answer({ ready: true, draining: false });
      if (req.url === "/mcp/manifest") return answer({ daemon_version: version, tools: [{ name: "list_projects", description: "d", inputSchema: { type: "object" } }] });
      if (req.url === "/mcp/rpc") { calls++; return answer({ id: "x", result: ["served"] }); }
      answer({ ok: true });
    });
    await new Promise((r) => fake.listen(0, "127.0.0.1", r));
    ({ port } = fake.address());
    pidfile(999_999_991);
  });
  after(async () => { rmSync(join(w.data, "daemon.pid"), { force: true }); await w.stop(); fake.close(); });

  test("the same version, or one that can't be told, is served without a word", async () => {
    for (const same of [`${await own()}-rs.1`, "", "unknown"]) {
      version = same;
      const c = client({ keepErrors: true });
      await c.hello();
      assert.deepEqual((await c.call("list_projects")).value, ["served"], same);
      assert.deepEqual(await c.toolNames(), ["list_projects"]);
      assert.equal(c.errors, "");
    }
  });

  test("another minor or patch version is served, with one warning on standard error", async () => {
    const mine = await own();
    version = mine.replace(/\d+$/, (n) => String(Number(n) + 1));
    const c = client({ keepErrors: true });
    await c.hello();
    assert.deepEqual(await c.toolNames(), ["list_projects"]);
    assert.deepEqual((await c.call("list_projects")).value, ["served"]);
    await c.toolNames();
    await until(() => c.errors.includes("\n"), 5000, "the warning");
    assert.equal(c.errors, `[scrybe] daemon version ${version} differs from shim ${mine} (minor/patch) — restart daemon to refresh tool surface\n`);
  });

  test("another major version is refused, and served again once the server is replaced", async () => {
    const mine = await own();
    version = "99.1.0";
    const c = client();
    await c.hello();
    const served = calls;
    const told = `daemon version 99.1.0 is major-incompatible with shim ${mine}. Restart to update: scrybe daemon restart`;
    const refused = await c.call("list_projects");
    assert.deepEqual([refused.value, refused.isError], [{ error: told }, false]);
    const { tools } = (await c.rpc("tools/list")).result;
    assert.deepEqual(tools, [{ name: "scrybe_daemon_unavailable", description: told, inputSchema: { type: "object", properties: {}, required: [] } }]);
    assert.equal(calls, served, "nothing was sent on");
    version = mine;
    pidfile(999_999_992);
    await until(() => c.notes.includes("notifications/tools/list_changed"), 10_000, "the notice");
    assert.deepEqual((await c.call("list_projects")).value, ["served"]);
  });

  test("a server from before the index format changed offers only what needs none", async () => {
    version = "0.33.2";
    const c = client();
    await c.hello();
    assert.deepEqual(await c.toolNames(), ["status", "doctor", "init"]);
    assert.match((await c.call("search_code", { project_id: "demo", query: "x" })).value.error, /^Run: scrybe daemon restart --force   \(then reconnect\)\n\nscrybe v0\.34\.0 upgraded lancedb\./);
    assert.equal((await c.call("status")).value.daemon_running, false);
  });
});

describe("the old flat commands", () => {
  let w;
  before(async () => { w = await makeWorld(); await w.cli("projects"); });
  after(() => w.stop());

  const note = (old, now) => `[deprecated] '${old}' renamed to '${now}'; will be removed in v1.0\n`;
  const uncaught = (message) => `scrybe error: Error: ${message}\n`;
  const same = async (args, want) => {
    const r = await w.cli(...args);
    assert.deepEqual([r.status, r.stdout, r.stderr], want, args.join(" "));
  };

  test("projects are added, described, listed and removed under their old names", async () => {
    const added = note("add-project", "project add");
    await same(["add-project", "--id", "extra", "--desc", "Second"], [0, "Added project 'extra'\n", added]);
    await same(["add-project", "--id", "extra"], [1, "", added + uncaught("Project 'extra' already exists")]);
    await same(["update-project", "--id", "extra", "--desc", ""], [0, "Updated project 'extra'\n", note("update-project", "project update")]);
    const r = await w.cli("list-projects");
    assert.deepEqual([r.status, r.stderr], [0, note("list-projects", "project list")]);
    assert.match(r.stdout, /\nextra\n {2}\(no sources\)\n$/);
    await same(["remove-project", "--id", "extra"], [0, "Removed project 'extra'\n", note("remove-project", "project remove")]);
    await same(["remove-project", "--id", "extra"], [1, "", note("remove-project", "project remove") + uncaught("Project 'extra' not found")]);
  });

  test("sources are added, changed and removed under their old names", async () => {
    let r = await w.cli("add-source", "-P", "demo", "-S", "two", "--type", "code", "--root", w.repo);
    assert.deepEqual([r.status, r.stderr], [0, note("add-source", "source add")]);
    assert.match(r.stdout, /^Added source 'two' to project 'demo' — reindex job: [0-9a-f]{8}\n$/);
    await same(["update-source", "-P", "demo", "-S", "two", "--languages", "ts"], [0, "Updated source 'two' in project 'demo'\n", note("update-source", "source update")]);
    await same(["remove-source", "--project-id", "demo", "--source-id", "two"], [0, "Removed source 'two' from project 'demo'\n", note("remove-source", "source remove")]);
    await same(["remove-source", "-P", "demo"], [1, "", "error: required option '--project-id <id>' not specified\n"]);
    r = await w.cliWith({ SCRYBE_NO_DEPRECATION_WARNING: "1" }, "add-source", "-P", "gone", "-S", "a", "--type", "code", "--root", w.repo);
    assert.deepEqual([r.status, r.stdout, r.stderr], [1, "", uncaught("Project 'gone' not found")]);
  });

  test("knowledge is searched under its old name", async () => {
    const told = note("search-knowledge", "search knowledge");
    await same(["search-knowledge", "--project-id", "demo"], [1, "", "error: missing required argument 'query'\n"]);
    const r = await w.cli("search-knowledge", "--project-id", "gone", "q");
    assert.equal(r.status, 1);
    assert.ok(r.stderr.startsWith(`${told}scrybe error: Error: `), r.stderr);
  });
});

describe("the model commands", () => {
  let w;
  before(async () => {
    w = await makeWorld();
    await w.index("--full");
    await w.cli("projects");
  });
  after(() => w.stop());

  const config = () => JSON.parse(readFileSync(join(w.data, "config.json"), "utf8"));
  const same = async (args, want) => {
    const r = await w.cli("model", ...args);
    assert.deepEqual([r.status, r.stdout, r.stderr], want, args.join(" "));
  };
  const refused = (message) => [1, "", `[scrybe] ${message}\n`];

  test("list is the catalog as a table", async () => {
    const r = await w.cli("model", "list");
    assert.deepEqual([r.status, r.stderr], [0, ""]);
    const lines = r.stdout.split("\n");
    assert.deepEqual(lines.slice(0, 3), ["Provider            Model                           Dim   Profile Notes", "-".repeat(71), "Voyage AI           voyage-code-3                   1024  code    "]);
    assert.ok(lines.includes("                    rerank-2                        -     rerank  "));
    assert.equal(lines.at(-2), "Custom (OpenAI-compatible)(user-defined)                  -     -       base_url + dim required");
  });

  test("show gives the assignments and what they resolve to, and no secret", async () => {
    const one = (label, resolved) => `=== ${label} preset: 'fake' ===\n\n  provider    : custom\n  model       : fake-model\n  base_url    : ${w.fake.url}\n  dim         : 8\n  credentials : \${CONTRACT_EMBED_KEY}\n  resolved    : ${resolved}\n\n`;
    const head = "=== Current Assignments ===\n\n  code_preset   : fake\n  text_preset   : fake\n  rerank_preset : (none)\n\n";
    await same(["show"], [0, head + one("code", "ok") + one("text", "ok"), ""]);
    const r = await w.cliBare({ SCRYBE_NO_AUTO_DAEMON: "1", CONTRACT_EMBED_KEY: undefined }, "model", "show");
    const why = "ERROR — env var CONTRACT_EMBED_KEY not set (referenced in scrybe config)";
    assert.deepEqual([r.status, r.stdout], [0, head + one("code", why) + one("text", why)]);
  });

  test("a preset is added, and refused when it makes no sense", async () => {
    const add = (...rest) => ["preset", "add", "mine", ...rest];
    await same(add("--provider", "nope", "--model", "m"), refused("Unknown provider: \"nope\". Run 'scrybe model list' to see available providers."));
    await same(add("--provider", "voyage", "--model", "m"), refused("Model \"m\" not found in provider \"voyage\". Run 'scrybe model list' to see available models."));
    await same(add("--provider", "voyage", "--model", "voyage-4", "--dim", "5"), refused("--dim is only valid for custom providers. Catalog providers derive dim from the model spec."));
    await same(add("--provider", "custom", "--model", "m", "--base-url", "http://x/v1"), refused("--dim is required for custom providers."));
    await same(["preset", "add", "--provider", "voyage", "--model", "voyage-4"], [1, "", "error: missing required argument 'name'\n"]);
    await same(add("--provider", "custom", "--model", "m", "--base-url", w.fake.url, "--dim", "8", "--encoding-format", "float", "--credentials-from", "fake"), [0, "Preset 'mine' added to config.json.\n", ""]);
    assert.deepEqual(config().embedding_presets.mine, { provider: "custom", model: "m", credentials_from: "fake", base_url: w.fake.url, dim: 8, encoding_format: "float" });
    await same(add("--provider", "voyage", "--model", "voyage-4"), refused("Preset 'mine' already exists. Edit its config.json entry, or add a new preset and assign it."));
  });

  test("presets are assigned together or not at all", async () => {
    const before = config();
    await same(["assign"], refused("At least one of --code, --text, or --rerank must be specified."));
    await same(["assign", "--code", "mine", "--text", "gone"], refused("Preset 'gone' not found in embedding_presets."));
    await same(["assign", "--text", "mine", "--rerank", "gone"], refused("Reranker preset 'gone' not found in reranker_presets."));
    assert.deepEqual(config(), before);
    await same(["assign", "--code", "mine", "--rerank", "none"], [0, "Rerank preset cleared.\nAssignments updated in config.json.\n", ""]);
    assert.deepEqual(config().assignments, { code_preset: "mine", text_preset: "fake" });
  });

  test("a preset in use stays", async () => {
    await same(["preset", "rm", "gone"], refused("Preset 'gone' not found in embedding_presets."));
    await same(["preset", "rm", "mine"], refused("Cannot remove preset 'mine': it is currently assigned. Use 'scrybe model assign' to switch to a different preset first."));
    await same(["assign", "--code", "mine", "--text", "mine"], [0, "Assignments updated in config.json.\n", ""]);
    await same(["preset", "rm", "fake"], refused("Cannot remove preset 'fake': it is referenced via credentials_from by preset 'mine'."));
    await same(["assign", "--code", "fake", "--text", "fake"], [0, "Assignments updated in config.json.\n", ""]);
    await same(["preset", "remove", "mine"], [0, "Preset 'mine' removed from config.json.\n", ""]);
    assert.deepEqual(Object.keys(config().embedding_presets), ["fake"]);
  });

  test("switch asks first, and only a person can answer", async () => {
    await same(["switch", "--source-type", "both"], refused("--source-type must be 'code' or 'text', got: 'both'"));
    await same(["switch", "--source-type", "text"], [0, "No text sources found. Nothing to switch.\n", ""]);
    const r = await w.cli("model", "switch", "--source-type", "code");
    assert.deepEqual([r.status, r.stderr], [1, "[scrybe] Non-interactive input. Pass --yes to confirm without a prompt.\n"]);
    assert.match(r.stdout, /^\nSwitching 1 code source\(s\) to preset 'fake':\n {2}Provider : custom\n {2}Model {4}: fake-model\n {2}Dim {6}: 8\n\n {2}demo\/primary {2}\((\d+) chunks currently indexed\)\n\n {2}Estimated tokens to re-embed: ~[\d,]+ \(\1 chunks × 500 tokens avg\)\. Check your provider's pricing for cost\.\n\n {2}This will drop and fully reindex the affected tables\. All existing vectors will be replaced\.\n$/);
  });

  test("switch rebuilds the sources and notes what built them", async () => {
    const calls = w.fake.log.length;
    const r = await w.cli("model", "switch", "--source-type", "code", "--yes");
    assert.deepEqual([r.status, r.stderr], [0, ""]);
    const tail = r.stdout.slice(r.stdout.indexOf("\nReindexing...")).replace(/\r[^\r\n]*/g, "");
    assert.equal(tail, "\nReindexing...\n  demo/primary...\n    Done.\n\nAll 1 source(s) reindexed with preset 'fake'.\n\nTables recreated. If an MCP client (Claude Code, Cline) is connected, restart it to pick up the new tables.\n");
    assert.ok(w.fake.log.length > calls);
    const [{ sources: [source] }] = JSON.parse(readFileSync(join(w.data, "projects.json"), "utf8"));
    const meta = JSON.parse(readFileSync(join(w.data, "lancedb", `${source.table_name}-meta.json`), "utf8"));
    assert.deepEqual([meta.model, meta.dim, meta.provider, meta.preset_at_index_time], ["fake-model", 8, "custom", "fake"]);
    assert.ok(Date.parse(meta.indexed_at) > 0 && meta.chunk_id_scheme >= 1, JSON.stringify(meta));
    assert.match((await w.cli("search", "code", "-P", "demo", "frobnicateWidget")).stdout, /src\/widget\.ts/);
  });
});

describe("a command that needs a server", () => {
  let w, gl, container;
  before(async () => {
    gl = await fakeGitlab();
    w = await makeWorld();
    container = (await w.cliBare({}, "daemon", "up", "--verbose")).stdout.startsWith("Skipping daemon start (container)");
    await w.killServer();
  });
  afterEach(() => w.killServer());
  after(async () => { await w.stop(); gl.close(); });

  const sources = () => JSON.parse(readFileSync(join(w.data, "projects.json"), "utf8"))[0].sources.map((s) => s.source_id);
  /** A slow machine may need longer than a command waits; the server it began is there for the next try. */
  const patient = async (run) => {
    for (let i = 0; ; i++) {
      const r = await run();
      if (r.status === 0 || i === 5 || !/failed to start/.test(r.stderr)) return r;
      await sleep(2000);
    }
  };

  test("starts it to index", async (t) => {
    if (container) return t.skip("this host counts as a container");
    const r = await patient(() => w.cliLive("index", "-P", "demo", "-S", "primary", "--detach"));
    assert.equal(r.status, 0, r.stderr);
    assert.match(r.stdout, /^Job \w+: [0-9a-f]{8}( \(queue position: \d+\))?\n$/);
    assert.ok(await w.health());
  });

  test("starts it to add a source, with the variable the source's token names", async (t) => {
    if (container) return t.skip("this host counts as a container");
    const r = await patient(() => w.cliBare({ CONTRACT_PAT: GITLAB_TOKEN }, "source", "add", "-P", "demo", "-S", "tickets", "--type", "ticket", "--url", gl.url, "--project", GITLAB_PROJECT, "--token", "${CONTRACT_PAT}"));
    assert.deepEqual([r.status, r.stderr], [0, ""]);
    assert.match(r.stdout, /^Added source 'tickets' to project 'demo' — reindex job: [0-9a-f]{8}\n$/);
    const id = r.stdout.match(/job: (\w+)/)[1];
    const c = w.client();
    await c.hello();
    const done = await until(async () => { const s = (await c.call("reindex_status", { job_id: id })).value; return s?.status !== "running" && s?.status !== "queued" && s; }, 60_000, "the job to finish");
    assert.equal(done.status, "done", JSON.stringify(done));
  });

  test("won't work without one that can't start, and takes back the source it saved", async (t) => {
    if (container) return t.skip("this host counts as a container");
    let r = await w.cliBare({ SCRYBE_DAEMON_PORT: "9999999" }, "index", "-P", "demo", "-S", "primary");
    assert.deepEqual([r.status, r.stdout, r.stderr], [1, "", "[scrybe] Error: the scrybe daemon failed to start.\nReindex requires the daemon to coordinate writes.\nDiagnose with: scrybe doctor\nSingle-shot:   SCRYBE_NO_AUTO_DAEMON=1 scrybe index ...\n"]);
    const before = sources();
    r = await w.cliBare({ SCRYBE_DAEMON_PORT: "9999999" }, "source", "add", "-P", "demo", "-S", "late", "--type", "code", "--root", w.repo);
    assert.deepEqual([r.status, r.stdout, r.stderr], [1, "", "[scrybe] The scrybe daemon failed to start. Reindex requires the daemon to coordinate writes.\nDiagnose: scrybe doctor  |  Single-shot: SCRYBE_NO_AUTO_DAEMON=1 scrybe index ...\n"]);
    assert.deepEqual(sources(), before);
  });

  test("gives up on one that is on its way out", async (t) => {
    if (container) return t.skip("this host counts as a container");
    const fake = createHttpServer((req, res) => {
      req.resume();
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ ready: true, draining: true }));
    });
    await new Promise((r) => fake.listen(0, "127.0.0.1", r));
    writeFileSync(join(w.data, "daemon.pid"), JSON.stringify({ pid: 999_999_991, port: fake.address().port }));
    const retry = "Retry in a moment — a replacement daemon starts on the next call.\n";
    try {
      let r = await w.cliLive("index", "-P", "demo", "-S", "primary");
      assert.deepEqual([r.status, r.stdout, r.stderr], [1, "", `[scrybe] Error: the scrybe daemon is shutting down and is not accepting new jobs.\n${retry}`]);
      const leaving = `[scrybe] The scrybe daemon is shutting down (finishing in-flight work) and is not accepting new jobs.\n${retry}`;
      const before = sources();
      r = await w.cliLive("source", "add", "-P", "demo", "-S", "late", "--type", "code", "--root", w.repo);
      assert.deepEqual([r.status, r.stdout, r.stderr], [1, "", leaving]);
      assert.deepEqual(sources(), before);
      r = await w.cliLive("drop-ephemeral", "-P", "demo", "--label", "_ephemeral/x");
      assert.deepEqual([r.status, r.stdout, r.stderr], [1, "", leaving]);
    } finally {
      rmSync(join(w.data, "daemon.pid"), { force: true });
      fake.closeAllConnections();
      fake.close();
    }
  });
});

describe("the mcp command", () => {
  let w, container;
  const command = [...CLI, "mcp"];
  before(async () => {
    w = await makeWorld();
    container = (await w.cliBare({}, "daemon", "up", "--verbose")).stdout.startsWith("Skipping daemon start (container)");
    await w.killServer();
  });
  after(() => w.stop());

  test("with starting switched off, offers only what needs no server", async () => {
    const c = w.client({ command, extraEnv: { SCRYBE_NO_AUTO_DAEMON: "1", SCRYBE_MCP_COLD_START_WAIT_MS: "0" } });
    const m = await c.hello();
    assert.equal(m.result.serverInfo.name, "scrybe");
    assert.deepEqual(await c.toolNames(), ["status", "doctor", "init"]);
    assert.equal(w.pidfile(), null);
  });

  test("starts the shared server and carries the calls", async (t) => {
    if (container) return t.skip("this host counts as a container");
    const c = w.client({ command, extraEnv: { SCRYBE_MCP_COLD_START_WAIT_MS: "20000", SCRYBE_DAEMON_HEARTBEAT_MS: "1000" } });
    await c.hello();
    assert.equal(w.pidfile(), null, "the handshake needs no server");
    await c.toolNames();
    await until(() => w.health(), 60_000, "the server");
    const wanted = ["search_code", "list_projects", "reindex_project", "gc"];
    await until(async () => { const names = await c.toolNames(); return wanted.every((n) => names.includes(n)); }, 30_000, "the server's tools");
    const r = await c.call("list_projects");
    assert.equal(r.value[0].id, "demo");
    await until(async () => { const pf = w.pidfile(); return (await (await fetch(`http://127.0.0.1:${pf.port}/status`)).json()).clientCount >= 1; }, 30_000, "the client to be counted");
  });

  test("--legacy-in-process answers by itself, and says it is going away", async () => {
    await w.killServer();
    const c = w.client({ command: [...command, "--legacy-in-process"], extraEnv: { SCRYBE_NO_AUTO_DAEMON: "1" }, keepErrors: true });
    await c.hello();
    assert.equal((await c.call("list_projects")).value[0].id, "demo");
    assert.ok(c.errors.includes("[scrybe] in-process MCP mode is deprecated, will be removed in v0.34.0. See `scrybe daemon install`.\n"), c.errors);
    assert.equal(w.pidfile(), null);
  });
});

describe("a signal to a command at work", { skip: process.platform === "win32" ? "no signals on Windows" : false }, () => {
  let w, embedder, release;
  before(async () => {
    embedder = await fakeEmbedder();
    w = await makeWorld({ embedder });
    await w.cli("projects");
    embedder.gate.hold = new Promise((r) => { release = r; });
  });
  after(async () => { release(); await w.stop(); embedder.close(); });

  for (const [signal, args] of [["SIGINT", ["index", "-P", "demo", "-S", "primary"]], ["SIGTERM", ["index", "--all"]], ["SIGTERM", ["source", "add", "-P", "demo", "-S", "two", "--type", "code"]]]) {
    test(`${signal} ends ${args[0]} ${args[1]} at once, without an error`, async () => {
      const waiting = embedder.gate.waiting;
      const p = spawn(CLI[0], [...CLI.slice(1), ...args, ...(args[0] === "source" ? ["--root", w.repo] : [])], { env: { ...w.env, SCRYBE_NO_AUTO_DAEMON: "1" }, stdio: ["ignore", "pipe", "pipe"] });
      let errors = "";
      p.stderr.on("data", (d) => { errors += d; });
      p.stdout.resume();
      const gone = new Promise((r) => p.on("exit", (code, by) => r([code, by])));
      await until(() => embedder.gate.waiting > waiting, 60_000, "the embedding request");
      p.kill(signal);
      assert.deepEqual(await gone, [0, null]);
      assert.equal(errors, "");
    });
  }

  test("leaves its job as it was, for the next server to close", async () => {
    const db = new DatabaseSync(join(w.data, "branch-tags.db"), { readOnly: true });
    try {
      assert.deepEqual(db.prepare("SELECT status, finished_at FROM jobs").all().map((r) => ({ ...r })), [{ status: "running", finished_at: null }]);
    } finally { db.close(); }
  });
});

describe("a server of another version", () => {
  let w, own;
  before(async () => {
    w = await makeWorld();
    await w.cli("projects");
    own = (await w.cli("--version")).stdout.trim();
  });
  after(async () => { rmSync(join(w.data, "daemon.pid"), { force: true }); await w.stop(); });

  const pidfile = (version) => writeFileSync(join(w.data, "daemon.pid"), JSON.stringify({ pid: 999_999_991, port: 1, version }));

  test("is mentioned once by any command", async () => {
    pidfile("0.0.1");
    const notice = `[scrybe] daemon is running v0.0.1 but CLI is v${own}.\n[scrybe] Restart to pick up new code: scrybe daemon stop  (auto-respawns on next call)\n`;
    for (const args of [["projects"], ["model", "list"], ["--version"], ["index", "--help"]]) {
      const r = await w.cli(...args);
      assert.deepEqual([r.status, r.stderr], [0, notice], args.join(" "));
    }
    assert.equal((await w.cli("completion")).stderr, `${notice}error: missing required argument 'shell'\n`);
  });

  test("is not mentioned where a program reads the output, or for the same version", async () => {
    pidfile("0.0.1");
    assert.equal((await w.cli("ignore", "list", "--json")).stderr, "");
    assert.equal((await w.cliWith({ SCRYBE_JSON_OUTPUT: "1" }, "projects")).stderr, "");
    for (const version of [own, undefined, ""]) {
      pidfile(version);
      assert.equal((await w.cli("projects")).stderr, "", String(version));
    }
  });
});

describe("what the command line says when it is misused", () => {
  let w;
  before(async () => { w = await makeWorld(); await w.cli("projects"); });
  after(() => w.stop());

  for (const [line, text] of [
    ["search code", "required option '-P, --project-id <id>' not specified"],
    ["search code -P demo", "missing required argument 'query'"],
    ["search knowledge -P demo", "missing required argument 'query'"],
    ["search code -P", "option '-P, --project-id <id>' argument missing"],
    ["search code -P demo --nope q", "unknown option '--nope'"],
    ["index --project-idd demo", "unknown option '--project-idd'\n(Did you mean --project-id?)"],
    ["index -P demo extra", "too many arguments for 'index'. Expected 0 arguments but got 1: extra."],
    ["gc -z", "unknown option '-z'"],
    ["project lst", "unknown command 'lst'\n(Did you mean one of list, ls?)"],
    ["daemon zzzzzz", "unknown command 'zzzzzz'"],
    ["completion bash zsh", "too many arguments for 'completion'. Expected 1 argument but got 2: bash, zsh."],
    ["nonsense", "too many arguments. Expected 0 arguments but got 1: nonsense."],
    ["drop-ephemeral -P demo", "required option '--label <label>' not specified"],
  ]) {
    test(`scrybe ${line}`, async () => {
      const r = await w.cli(...line.split(" "));
      assert.deepEqual([r.status, r.stdout, r.stderr], [1, "", `error: ${text}\n`]);
    });
  }

  test("the last of a repeated option wins, and a value may start with a dash", async () => {
    let r = await w.cli("project", "add", "--id", "one", "--id", "two", "--desc", "x", "--desc", "--dashed");
    assert.deepEqual([r.status, r.stdout, r.stderr], [0, "Added project 'two'\n", ""]);
    assert.equal(JSON.parse(readFileSync(join(w.data, "projects.json"), "utf8")).find((p) => p.id === "two").description, "--dashed");
    r = await w.cli("ignore", "list", "-P", "nope", "-P", "demo", "--json", "--json");
    assert.deepEqual([r.status, r.stdout, r.stderr], [0, "[]\n", ""]);
    r = await w.cli("ignore", "list", "-P", "-odd");
    assert.deepEqual([r.status, r.stderr], [1, "[scrybe] Project '-odd' not found\n"]);
    r = await w.cli("branch", "pin", "-P", "demo", "-5");
    assert.equal(r.status, 0, r.stderr);
    assert.deepEqual(JSON.parse(r.stdout).added, ["-5"]);
  });
});

describe("help", () => {
  let w;
  before(async () => { w = await makeWorld(); await w.cli("projects"); });
  after(() => w.stop());

  const help = async (...args) => {
    const r = await w.cli(...args, "--help");
    assert.deepEqual([r.status, r.stderr], [0, ""], args.join(" "));
    return r.stdout.replace(/\s+/g, " ");
  };

  test("lists the commands people use and none of the others", async () => {
    const text = await help();
    for (const part of ["Usage: scrybe ", "Self-hosted semantic code search", "Manage registered projects", "Edit per-source private ignore rules (stored in DATA_DIR — never committed)", "Manage embedding model presets and assignments"]) assert.ok(text.includes(part), part);
    for (const hidden of ["add-project", "search-knowledge", "deprecated", "debug-", " mcp "]) assert.ok(!text.includes(hidden), hidden);
    assert.ok(!(await help("daemon")).includes("kick"));
  });

  for (const [command, ...parts] of [
    ["index", "Usage: scrybe index ", "Comma-separated source IDs (e.g. primary,gitlab-issues)", "Examples: scrybe index -P myrepo scrybe index -P myrepo -S primary,gitlab-issues scrybe index --all"],
    ["source add", "auto-enqueue a reindex", "[deprecated: use --token] GitLab personal access token", "scrybe source add -P myrepo -S gh-issues --type ticket --provider github"],
    ["search code", "Search query", "Branch to search (default: current HEAD)", 'Example: scrybe search code -P myrepo "auth flow"'],
    ["daemon stop", "Gracefully stop the running daemon", "Abandon the drain", "scrybe daemon stop --force # don't wait for an in-flight reindex"],
    ["model preset add", "Provider key (voyage, openai, local, custom)", "scrybe model preset add together-bert --provider custom"],
    ["ignore", "It is applied additively on top of .gitignore and .scrybeignore."],
  ]) {
    test(`scrybe ${command}`, async () => {
      const text = await help(...command.split(" "));
      for (const part of parts) assert.ok(text.includes(part), `${part}\n${text}`);
    });
  }
});
