// Same call, same answer: every test here passes against today's TypeScript build, and is written so
// the Rust build can be held to it. A tool a build doesn't have yet shows as skipped, not passed.
import assert from "node:assert/strict";
import { readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { after, before, describe, test } from "node:test";
import { BUILD, CLI, RELAY, SERVER, makeWorld, sleep, until } from "./harness.mjs";

// Behaviour the Rust build doesn't match yet. Listed as todo, so they run and report without failing the run.
const RUST_GAPS = new Set([]);
const gap = (name) => (BUILD === "rust" && RUST_GAPS.has(name) ? { todo: "not matched by the Rust build yet" } : {});

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
