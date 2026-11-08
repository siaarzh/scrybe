// Runs either build of scrybe from the outside: a throwaway git repo, a throwaway data dir, a fake
// embedding endpoint, the tiny client talking to a real server, and the command line.
import { execFileSync, spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import http from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createInterface } from "node:readline";

const fromEnv = (name) => {
  const raw = process.env[name];
  if (!raw) throw new Error(`${name} must be set: see rust/contract/README.md`);
  return JSON.parse(raw);
};

export const BUILD = process.env.SCRYBE_CONTRACT_BUILD ?? "rust";
export const SERVER = fromEnv("SCRYBE_CONTRACT_SERVER");
export const CLI = fromEnv("SCRYBE_CONTRACT_CLI");
export const RELAY = fromEnv("SCRYBE_CONTRACT_RELAY");
export const DIM = 8;

export const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

export async function until(cond, ms = 30_000, what = "condition") {
  const end = Date.now() + ms;
  for (;;) {
    const v = await cond();
    if (v) return v;
    if (Date.now() > end) throw new Error(`timed out waiting for ${what}`);
    await sleep(100);
  }
}

export function vectorFor(text) {
  const d = createHash("sha256").update(text).digest();
  const v = Array.from(d.subarray(0, DIM), (b) => b / 255);
  const n = Math.hypot(...v) || 1;
  return v.map((x) => x / n);
}

/** An OpenAI-compatible endpoint whose vectors depend only on the text. */
export async function fakeEmbedder() {
  const log = [];
  const server = http.createServer((req, res) => {
    const chunks = [];
    req.on("data", (c) => chunks.push(c));
    req.on("end", () => {
      const body = JSON.parse(Buffer.concat(chunks).toString("utf8"));
      const input = Array.isArray(body.input) ? body.input : [body.input];
      log.push({ auth: req.headers.authorization, n: input.length, encoding: body.encoding_format });
      const data = input.map((t, index) => {
        const vec = vectorFor(t);
        const embedding = body.encoding_format === "base64" ? Buffer.from(new Float32Array(vec).buffer).toString("base64") : vec;
        return { object: "embedding", index, embedding };
      });
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ object: "list", model: body.model, data, usage: { prompt_tokens: 1, total_tokens: 1 } }));
    });
  });
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  return { url: `http://127.0.0.1:${server.address().port}/v1`, log, close: () => server.close() };
}

export const GITLAB_TOKEN = "contract-gitlab-token";
export const GITLAB_PROJECT = "demo/tracker";

/** A minimal GitLab issues API: list, one issue and its notes, 100 per page, `updated_after`, bearer auth. */
export async function fakeGitlab({ token = GITLAB_TOKEN } = {}) {
  const state = { issues: [], notes: {}, log: [] };
  const server = http.createServer((req, res) => {
    state.log.push({ url: req.url, auth: req.headers.authorization, contentType: req.headers["content-type"] });
    const send = (code, body) => {
      res.writeHead(code, { "Content-Type": "application/json" });
      res.end(JSON.stringify(body));
    };
    if (req.headers.authorization !== `Bearer ${token}`) return send(401, { message: "401 Unauthorized" });
    const url = new URL(req.url, "http://localhost");
    const m = url.pathname.match(/^\/api\/v4\/projects\/([^/]+)\/issues(?:\/(\d+)(\/notes)?)?$/);
    if (!m || decodeURIComponent(m[1]) !== GITLAB_PROJECT) return send(404, { message: "404 Not Found" });
    const page = (all) => {
      const per = Number(url.searchParams.get("per_page") ?? 20);
      const n = Number(url.searchParams.get("page") ?? 1);
      return all.slice((n - 1) * per, n * per);
    };
    if (m[2] === undefined) {
      const since = url.searchParams.get("updated_after");
      return send(200, page(state.issues.filter((i) => since === null || Date.parse(i.updated_at) >= Date.parse(since))));
    }
    const issue = state.issues.find((i) => i.iid === Number(m[2]));
    if (!issue) return send(404, { message: "404 Not found" });
    return send(200, m[3] ? page(state.notes[issue.iid] ?? []) : issue);
  });
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  return { url: `http://127.0.0.1:${server.address().port}`, state, close: () => server.close() };
}

export const GITHUB_TOKEN = "contract-github-token";
export const GITHUB_PROJECT = "acme/widgets";

/** A minimal GitHub issues API: list (pull requests included), one issue and its comments, 100 per page, `since`, bearer auth. `intercept(url)` may answer instead. */
export async function fakeGithub({ token = GITHUB_TOKEN } = {}) {
  const state = { issues: [], comments: {}, log: [], intercept: null };
  const server = http.createServer((req, res) => {
    state.log.push({ url: req.url, auth: req.headers.authorization, accept: req.headers.accept, version: req.headers["x-github-api-version"] });
    const send = (code, body, headers = {}) => {
      res.writeHead(code, { "Content-Type": "application/json", ...headers });
      res.end(JSON.stringify(body));
    };
    const forced = state.intercept?.(req.url);
    if (forced) return send(forced.code, forced.body ?? { message: "pushed back" }, forced.headers);
    if (req.headers.authorization !== `Bearer ${token}`) return send(401, { message: "Bad credentials" });
    const url = new URL(req.url, "http://localhost");
    const m = url.pathname.match(/^\/repos\/([^/]+\/[^/]+)\/issues(?:\/(\d+)(\/comments)?)?$/);
    if (!m || m[1] !== GITHUB_PROJECT) return send(404, { message: "Not Found" });
    const page = (all) => {
      const per = Number(url.searchParams.get("per_page") ?? 30);
      const n = Number(url.searchParams.get("page") ?? 1);
      return all.slice((n - 1) * per, n * per);
    };
    if (m[2] === undefined) {
      const since = url.searchParams.get("since");
      return send(200, page(state.issues.filter((i) => since === null || Date.parse(i.updated_at) >= Date.parse(since))));
    }
    const issue = state.issues.find((i) => i.number === Number(m[2]));
    if (!issue) return send(404, { message: "Not Found" });
    return send(200, m[3] ? page(state.comments[issue.number] ?? []) : issue);
  });
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  return { url: `http://127.0.0.1:${server.address().port}`, state, close: () => server.close() };
}

export const FILES = {
  "src/widget.ts": "export function frobnicateWidget(size: number): number {\n  // widens the widget by a fixed margin\n  return size + 12;\n}\n\nexport class WidgetStore {\n  count = 0;\n  addWidget(): number {\n    this.count += 1;\n    return this.count;\n  }\n}\n",
  "src/gadget.py": "def calibrate_gadget(level):\n    \"\"\"Sets the gadget to a level.\"\"\"\n    return level * 3\n\n\nclass GadgetRack:\n    def mount(self, gadget):\n        return gadget\n",
  "docs/skipped.txt": "not a language scrybe indexes\n",
  "notes/ignored.ts": "export function shouldNeverBeFound() { return 1; }\n",
  ".gitignore": "notes/\n",
};

function git(cwd, ...args) {
  const identity = ["-c", "user.name=contract", "-c", "user.email=contract@example.invalid", "-c", "core.hooksPath=/dev/null", "-c", "core.autocrlf=false", "-c", "commit.gpgsign=false"];
  return execFileSync("git", [...identity, ...args], { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }).trim();
}

export function makeRepo(root) {
  mkdirSync(root, { recursive: true });
  git(root, "init", "-q");
  for (const [rel, text] of Object.entries(FILES)) {
    mkdirSync(join(root, rel, ".."), { recursive: true });
    writeFileSync(join(root, rel), text);
  }
  git(root, "add", "-f", "src", "docs", ".gitignore");
  git(root, "commit", "-q", "-m", "first");
  git(root, "branch", "side");
  git(root, "checkout", "-q", "side");
  writeFileSync(join(root, "src/side_only.ts"), "export function onlyOnTheSideBranch() { return 42; }\n");
  git(root, "add", "src/side_only.ts");
  git(root, "commit", "-q", "-m", "side");
  git(root, "checkout", "-q", "-");
  return { main: git(root, "rev-parse", "--abbrev-ref", "HEAD"), git: (...a) => git(root, ...a) };
}

/** Everything one test group needs. `stop()` leaves nothing running. */
export async function makeWorld({ embedder, serverEnv = {}, pinned, withOrigin = false, extraSources = [] } = {}) {
  const dir = mkdtempSync(join(tmpdir(), "scrybe-contract-"));
  const fake = embedder ?? (await fakeEmbedder());
  const repo = join(dir, "repo");
  const data = join(dir, "data");
  mkdirSync(data);
  const repoInfo = makeRepo(repo);
  // A second clone stands in for the remote, so a fetch has something real to find.
  const origin = join(dir, "origin");
  if (withOrigin) {
    execFileSync("git", ["clone", "-q", "--no-hardlinks", repo, origin], { stdio: "ignore" });
    repoInfo.git("remote", "add", "origin", origin);
    git(origin, "checkout", "-q", "side");
    repoInfo.git("fetch", "-q", "origin");
  }
  const presets = { fake: { provider: "custom", model: "fake-model", dim: DIM, base_url: fake.url, credentials: "${CONTRACT_EMBED_KEY}" } };
  writeFileSync(join(data, "config.json"), JSON.stringify({ schema_version: 1, embedding_presets: presets, assignments: { code_preset: "fake", text_preset: "fake" } }, null, 2));
  const source = { source_id: "primary", source_config: { type: "code", root_path: repo, languages: [] }, ...(pinned ? { pinned_branches: pinned } : {}) };
  writeFileSync(join(data, "projects.json"), JSON.stringify([{ id: "demo", description: "A demo", sources: [source, ...extraSources] }], null, 2));
  const env = {
    ...process.env,
    SCRYBE_DATA_DIR: data,
    CONTRACT_EMBED_KEY: "contract-key",
    SCRYBE_DAEMON_CGROUP_MAX_MB: "0",
    SCRYBE_DAEMON_NO_FETCH: "1",
    SCRYBE_DAEMON_NO_TICKET_FETCH: "1",
    SCRYBE_AUTO_GC: "false",
    SCRYBE_DAEMON_KEEP_ALIVE: "1",
    ...serverEnv,
  };
  for (const k of ["SCRYBE_DAEMON_MCP_HTTP", "SCRYBE_DAEMON_PORT", "SCRYBE_NO_AUTO_DAEMON"]) delete env[k];

  const cliEnv = { ...env, SCRYBE_NO_AUTO_DAEMON: "1" };
  // Asynchronous, because the fake embedder lives in this process and has to keep answering.
  const cli = (...args) => new Promise((resolve) => {
    const p = spawn(CLI[0], [...CLI.slice(1), ...args], { env: cliEnv, cwd: dir, windowsHide: true, stdio: ["ignore", "pipe", "pipe"] });
    let stdout = "", stderr = "";
    p.stdout.on("data", (d) => { stdout += d; });
    p.stderr.on("data", (d) => { stderr += d; });
    const timer = setTimeout(() => p.kill(), 180_000);
    p.on("close", (status) => { clearTimeout(timer); resolve({ status, stdout, stderr }); });
  });
  const clients = [];
  const world = {
    dir, data, repo, origin, env, fake, cli, main: repoInfo.main, git: repoInfo.git, originGit: (...a) => git(origin, ...a),
    pidfile() {
      try { return JSON.parse(readFileSync(join(data, "daemon.pid"), "utf8")); } catch { return null; }
    },
    async health() {
      const pf = world.pidfile();
      if (!pf) return null;
      try {
        const r = await fetch(`http://127.0.0.1:${pf.port}/health`, { signal: AbortSignal.timeout(2000) });
        return r.ok ? await r.json() : null;
      } catch { return null; }
    },
    async index(...extra) {
      const r = await cli("index", "-P", "demo", "-S", "primary", ...extra);
      if (r.status !== 0) throw new Error(`index failed (${r.status}): ${r.stderr}${r.stdout}`);
      return r;
    },
    client(opts) {
      const c = new Client(env, opts);
      clients.push(c);
      return c;
    },
    /** Quits every client, kills the server and clears its pidfile, so nothing can answer or restart it. */
    async killServer() {
      for (const c of clients) c.close();
      clients.length = 0;
      await sleep(200);
      const pf = world.pidfile();
      if (pf) { try { process.kill(pf.pid, "SIGKILL"); } catch { /* gone */ } }
      await sleep(300);
      rmSync(join(data, "daemon.pid"), { force: true });
    },
    async stop() {
      for (const c of clients) c.close();
      await sleep(100);
      const pf = world.pidfile();
      if (pf) { try { process.kill(pf.pid, "SIGKILL"); } catch { /* gone */ } }
      if (!embedder) fake.close();
      await sleep(300);
      try { rmSync(dir, { recursive: true, force: true, maxRetries: 5 }); } catch { /* Windows can hold a closing file */ }
    },
  };
  return world;
}

/** The tiny client over stdio, starting the server named by this run. */
export class Client {
  constructor(env, { start = SERVER, extraEnv = {} } = {}) {
    this.p = spawn(RELAY[0], [...RELAY.slice(1), "--start", ...start], { env: { ...env, ...extraEnv }, stdio: ["pipe", "pipe", "ignore"], windowsHide: true });
    this.pending = new Map();
    this.notes = [];
    this.next = 0;
    createInterface({ input: this.p.stdout }).on("line", (line) => {
      const m = JSON.parse(line);
      if (m.id !== undefined && this.pending.has(m.id)) {
        this.pending.get(m.id)(m);
        this.pending.delete(m.id);
      } else if (m.id === undefined) {
        this.notes.push(m.method);
      }
    });
  }
  rpc(method, params = {}, ms = 120_000) {
    const id = ++this.next;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error(`no answer to ${method}`)), ms);
      this.pending.set(id, (m) => { clearTimeout(timer); resolve(m); });
      this.p.stdin.write(JSON.stringify({ jsonrpc: "2.0", id, method, params }) + "\n");
    });
  }
  raw(line) { this.p.stdin.write(line + "\n"); }
  async hello(protocolVersion = "2025-06-18") {
    const m = await this.rpc("initialize", { protocolVersion, capabilities: {}, clientInfo: { name: "contract", version: "1" } });
    this.raw(JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized" }));
    return m;
  }
  async toolNames() {
    const m = await this.rpc("tools/list");
    return m.result.tools.map((t) => t.name);
  }
  /** Returns { value, isError, text }. value is the parsed JSON, if it parses. */
  async call(name, args = {}) {
    const m = await this.rpc("tools/call", { name, arguments: args });
    if (m.error) return { rpcError: m.error };
    const text = m.result.content[0].text;
    let value;
    try { value = JSON.parse(text); } catch { /* plain text */ }
    return { value, text, isError: m.result.isError === true };
  }
  close() {
    try { this.p.stdin.end(); } catch { /* gone */ }
    setTimeout(() => { try { this.p.kill(); } catch { /* gone */ } }, 3000).unref();
  }
}
