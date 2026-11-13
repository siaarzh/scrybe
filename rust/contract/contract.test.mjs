// Same call, same answer: every test here passes against today's TypeScript build, and is written so
// the Rust build can be held to it. A tool a build doesn't have yet shows as skipped, not passed.
import assert from "node:assert/strict";
import { existsSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { request as httpRequest } from "node:http";
import { join } from "node:path";
import { spawn } from "node:child_process";
import { DatabaseSync } from "node:sqlite";
import { after, before, describe, test } from "node:test";
import { pathToFileURL } from "node:url";
import { BUILD, CLI, GITHUB_PROJECT, GITHUB_TOKEN, GITLAB_PROJECT, GITLAB_TOKEN, RELAY, SERVER, fakeGithub, fakeGitlab, makeWorld, sleep, until, vectorFor } from "./harness.mjs";

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

    r = await w.cliLive("daemon", "stop");
    assert.deepEqual([r.status, r.stdout, r.stderr], [0, "Daemon stopped.\n", ""]);
    assert.equal(w.pidfile(), null);
    r = await w.cliLive("daemon", "stop");
    assert.deepEqual([r.status, r.stdout], [0, "Daemon is not running.\n"]);
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
    await until(() => w.pidfile() === null, 20_000, "the pidfile to go");
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
    assert.deepEqual(log.slice(1), ["/api/v4/projects/demo%2Ftracker/issues/3", "/api/v4/projects/demo%2Ftracker/issues/3/notes?per_page=100&page=1"]);
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

test("the run's commands", () => {
  assert.ok(SERVER.length && CLI.length && RELAY.length);
});
