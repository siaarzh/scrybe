// Same call, same answer: every test here passes against today's TypeScript build, and is written so
// the Rust build can be held to it. A tool a build doesn't have yet shows as skipped, not passed.
import assert from "node:assert/strict";
import { readFileSync, rmSync, writeFileSync } from "node:fs";
import { request as httpRequest } from "node:http";
import { join } from "node:path";
import { spawn } from "node:child_process";
import { DatabaseSync } from "node:sqlite";
import { after, before, describe, test } from "node:test";
import { BUILD, CLI, RELAY, SERVER, makeWorld, sleep, until } from "./harness.mjs";

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
    rmSync(join(w.repo, "src/gadget.py"));
    await until(symbolGone(c, "calibrate_gadget", w.main), 30_000, "the second deletion to be noticed");
    await sleep(2500);
    assert.equal(scheduled().length, 1, JSON.stringify(scheduled()));
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

  test("a search on an unknown project exits non-zero and names it", async () => {
    const r = await w.cli("search", "code", "-P", "nope", "x");
    assert.notEqual(r.status, 0);
    assert.match(r.stderr + r.stdout, /nope/);
  });

  test("the command line lists projects as text", gap("the command line lists projects as text"), async () => {
    const r = await w.cli("project", "list");
    assert.equal(r.status, 0, r.stderr);
    assert.match(r.stdout, /demo/);
    assert.match(r.stdout, /primary/);
  });
});

test("the run's commands", () => {
  assert.ok(SERVER.length && CLI.length && RELAY.length);
});
