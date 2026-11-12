// Same call, same answer: every test here passes against today's TypeScript build, and is written so
// the Rust build can be held to it. A tool a build doesn't have yet shows as skipped, not passed.
import assert from "node:assert/strict";
import { existsSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
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

test("the run's commands", () => {
  assert.ok(SERVER.length && CLI.length && RELAY.length);
});
