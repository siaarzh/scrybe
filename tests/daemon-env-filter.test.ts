import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import {
  mkdtempSync, writeFileSync, rmSync, existsSync, statSync, readFileSync, mkdirSync,
} from "fs";
import { tmpdir } from "os";
import { join, dirname } from "path";

// The spawn paths would run `systemd-run` for real; both entry points are stubbed for the file.
vi.mock("child_process", async (importOriginal) => {
  const original = await importOriginal<typeof import("child_process")>();
  const { EventEmitter } = await import("events");
  return {
    ...original,
    spawn: vi.fn(() => {
      const child = new EventEmitter() as any;
      child.pid = 4242;
      child.unref = vi.fn();
      child.kill = vi.fn();
      return child;
    }),
    spawnSync: vi.fn(() => ({ status: 0, signal: null, pid: 4242, output: [], stdout: null, stderr: null })),
  };
});

const dataDir = () => process.env["SCRYBE_DATA_DIR"]!;

async function loadSpawn() {
  return import("../src/daemon/spawn-detached.js");
}

// ─── filterDaemonEnv ──────────────────────────────────────────────────────────

describe("filterDaemonEnv", () => {
  it("keeps the allowlisted exact names and prefixes", async () => {
    const { filterDaemonEnv } = await loadSpawn();
    const env = {
      PATH: "/usr/bin", HOME: "/home/u", USER: "u", LOGNAME: "u", SHELL: "/bin/zsh", LANG: "C.UTF-8",
      TZ: "UTC", TMPDIR: "/tmp", SSH_AUTH_SOCK: "/run/ssh", SSH_ASKPASS: "/bin/ask", KRB5CCNAME: "FILE:/tmp/k",
      DBUS_SESSION_BUS_ADDRESS: "unix:path=/run/user/1/bus", DEBUG: "x", NODE_OPTIONS: "--x",
      NODE_EXTRA_CA_CERTS: "/ca.pem", UV_THREADPOOL_SIZE: "8", SSL_CERT_FILE: "/c", HTTPS_PROXY: "http://p",
      http_proxy: "http://p", no_proxy: "localhost", OPENAI_BASE_URL: "http://o",
      LD_LIBRARY_PATH: "/opt/lib", LD_PRELOAD: "/opt/libjemalloc.so", GLIBC_TUNABLES: "glibc.malloc.arena_max=2",
      NIX_LD: "/nix/ld", NIX_LD_LIBRARY_PATH: "/nix/lib",
      NODE_USE_SYSTEM_CA: "1", NODE_COMPILE_CACHE: "/c", OPENSSL_CONF: "/etc/ssl/o.cnf", OPENSSL_MODULES: "/m",
      CI: "1", RUST_LOG: "info", OMP_NUM_THREADS: "2",
      SCRYBE_DATA_DIR: "/d", MALLOC_ARENA_MAX: "2", LC_ALL: "C", XDG_RUNTIME_DIR: "/run/user/1",
      GIT_SSH_COMMAND: "ssh", LANCE_IO_THREADS: "4", LANCEDB_LOG: "debug", HF_HOME: "/hf",
      NAPI_RS_FORCE_WASI: "0", TOKIO_WORKER_THREADS: "2", ORT_LOGGING_LEVEL: "3",
      ONNXRUNTIME_X: "1", GCM_CREDENTIAL_STORE: "cache",
      RAYON_NUM_THREADS: "2", RAYON_RS_NUM_CPUS: "2", RUST_MIN_STACK: "8388608", RUST_LIB_BACKTRACE: "0",
      UV_USE_IO_URING: "0", ELECTRON_RUN_AS_NODE: "1", npm_config_cache: "/n", npm_config_registry: "https://r",
    };

    const r = filterDaemonEnv(env, dataDir());

    expect(r.env).toEqual(env);
    expect(r.kept).toBe(Object.keys(env).length);
    expect(r.dropped).toBe(0);
  });

  it("drops everything else, including credentials of unrelated systems", async () => {
    const { filterDaemonEnv } = await loadSpawn();
    const r = filterDaemonEnv({
      PATH: "/usr/bin",
      AWS_SECRET_ACCESS_KEY: "aws",
      GMAIL_APP_PASSWORD: "gm",
      PMUX_SESSION_TOKEN: "pm",
      CLAUDE_CODE_MESSAGING_TOKEN: "cc",
      npm_config__authToken: "npm-tok",
      "npm_config_//registry.npmjs.org/:_password": "npm-pw",
      GH_TOKEN: "gh",
      GITHUB_TOKEN: "ghp",
      EDITOR: "vim",
      OPENAI_API_KEY: "sk-unused",
      NODE_AUTH_TOKEN: "npm-publish",
      HF_TOKEN: "hf_x",
      GIT_TOKEN: "git-secret",
      LANCE_AWS_SECRET_ACCESS_KEY: "lance-secret",
    }, dataDir());

    expect(Object.keys(r.env)).toEqual(["PATH"]);
    expect(r.kept).toBe(1);
    expect(r.dropped).toBe(14);
  });

  it("daemonKeepsEnvName answers for the allowlist and passthrough, not for config refs", async () => {
    const { daemonKeepsEnvName } = await loadSpawn();
    writeFileSync(join(dataDir(), "projects.json"), JSON.stringify([{ token: "${GITLAB_PAT}" }]));
    expect(daemonKeepsEnvName("SCRYBE_GITLAB_TOKEN", {})).toBe(true);
    expect(daemonKeepsEnvName("SCRYBE_PRESET_X", {})).toBe(false);
    expect(daemonKeepsEnvName("GITLAB_PAT", {})).toBe(false);
    expect(daemonKeepsEnvName("GITLAB_PAT", { SCRYBE_DAEMON_ENV_PASSTHROUGH: "A, GITLAB_PAT" })).toBe(true);
  });

  it("keeps SCRYBE_ credentials and lets config refs or the passthrough bring back a prefixed one", async () => {
    const { filterDaemonEnv } = await loadSpawn();
    writeFileSync(join(dataDir(), "config.json"), JSON.stringify({ presets: { a: { key: "${GIT_TOKEN}" } } }));
    const r = filterDaemonEnv({ SCRYBE_GITLAB_TOKEN: "s", GIT_TOKEN: "g", HF_TOKEN: "h", SCRYBE_DAEMON_ENV_PASSTHROUGH: "HF_TOKEN" }, dataDir());
    expect(Object.keys(r.env).sort()).toEqual(["GIT_TOKEN", "HF_TOKEN", "SCRYBE_DAEMON_ENV_PASSTHROUGH", "SCRYBE_GITLAB_TOKEN"]);
  });

  it("processEnvNames reads a live process's variable names and reports a missing one as gone", async () => {
    const { processEnvNames } = await loadSpawn();
    if (process.platform !== "linux") return;
    const own = processEnvNames(process.pid);
    expect(own).toBeInstanceOf(Set);
    expect((own as Set<string>).has("PATH")).toBe(true);
    expect([...(own as Set<string>)].every((n) => !n.includes("="))).toBe(true);
    expect(processEnvNames(2 ** 22 + 12345)).toBe("gone");
  });

  it("drops the GIT_ variables that would redirect the daemon's own git calls", async () => {
    const { filterDaemonEnv } = await loadSpawn();
    const r = filterDaemonEnv({
      GIT_DIR: "/elsewhere/.git", GIT_WORK_TREE: "/elsewhere", GIT_INDEX_FILE: "/elsewhere/index",
      GIT_SSH_COMMAND: "ssh -i k", GIT_TERMINAL_PROMPT: "0",
    }, dataDir());

    expect(Object.keys(r.env).sort()).toEqual(["GIT_SSH_COMMAND", "GIT_TERMINAL_PROMPT"]);
  });

  it("drops SCRYBE_PRESET_* even though SCRYBE_ is an allowed prefix", async () => {
    const { filterDaemonEnv } = await loadSpawn();
    const r = filterDaemonEnv({ SCRYBE_PRESET_FOO: "resolved-secret", SCRYBE_FOO: "1" }, dataDir());
    expect(Object.keys(r.env)).toEqual(["SCRYBE_FOO"]);
  });

  it("forwards variables only read at process start, such as ones the spawner loaded from .env", async () => {
    const { filterDaemonEnv, daemonSpawnEnv } = await loadSpawn();
    const env = daemonSpawnEnv({
      MALLOC_ARENA_MAX: "4", NODE_OPTIONS: "--max-old-space-size=512", NODE_EXTRA_CA_CERTS: "/ca.pem",
    });

    const r = filterDaemonEnv(env, dataDir());

    expect(r.env["MALLOC_ARENA_MAX"]).toBe("4");
    expect(r.env["NODE_OPTIONS"]).toBe("--max-old-space-size=512");
    expect(r.env["NODE_EXTRA_CA_CERTS"]).toBe("/ca.pem");
  });

  it("keeps every ${VAR} referenced in config.json and projects.json, and reports the missing ones", async () => {
    const { filterDaemonEnv } = await loadSpawn();
    writeFileSync(join(dataDir(), "config.json"), JSON.stringify({
      schema_version: 1,
      embedding_presets: { p: { provider: "voyage", model: "m", credentials: "${MY_VOYAGE_KEY}" } },
    }));
    writeFileSync(join(dataDir(), "projects.json"), JSON.stringify([
      { id: "x", sources: [
        { source_id: "a", source_config: { type: "ticket", token: "Bearer ${MY_GITLAB_TOKEN}" } },
        { source_id: "b", source_config: { type: "ticket", token: "${TENV_NOT_SET_B}" } },
        { source_id: "c", source_config: { type: "ticket", token: "${TENV_NOT_SET_A}" } },
      ] },
    ]));

    const r = filterDaemonEnv(
      { MY_VOYAGE_KEY: "v", MY_GITLAB_TOKEN: "g", OTHER_TOKEN: "o" },
      dataDir(),
    );

    expect(r.env).toEqual({ MY_VOYAGE_KEY: "v", MY_GITLAB_TOKEN: "g" });
    expect(r.missingRefs).toEqual(["TENV_NOT_SET_A", "TENV_NOT_SET_B"]);
  });

  it("keeps the names listed in SCRYBE_DAEMON_ENV_PASSTHROUGH, comma or space separated", async () => {
    const { filterDaemonEnv } = await loadSpawn();
    const r = filterDaemonEnv({
      SCRYBE_DAEMON_ENV_PASSTHROUGH: "GH_TOKEN, FOO_BAR  BAZ,,",
      GH_TOKEN: "gh", FOO_BAR: "f", BAZ: "b", NOT_LISTED: "n",
    }, dataDir());

    expect(Object.keys(r.env).sort()).toEqual(["BAZ", "FOO_BAR", "GH_TOKEN", "SCRYBE_DAEMON_ENV_PASSTHROUGH"]);
  });

  it("never lets the passthrough list forward SCRYBE_PRESET_*", async () => {
    const { filterDaemonEnv } = await loadSpawn();
    const r = filterDaemonEnv({
      SCRYBE_DAEMON_ENV_PASSTHROUGH: "SCRYBE_PRESET_X",
      SCRYBE_PRESET_X: "p",
    }, dataDir());

    expect(Object.keys(r.env)).toEqual(["SCRYBE_DAEMON_ENV_PASSTHROUGH"]);
  });

  it("treats a missing data dir as no references, without throwing", async () => {
    const { filterDaemonEnv } = await loadSpawn();
    const r = filterDaemonEnv({ MY_GITLAB_TOKEN: "g", PATH: "/usr/bin" }, join(dataDir(), "nope"));
    expect(r.env).toEqual({ PATH: "/usr/bin" });
    expect(r.missingRefs).toEqual([]);
  });

  it("takes no references from a corrupt or unreadable file, but still reads the other one", async () => {
    const { filterDaemonEnv } = await loadSpawn();
    writeFileSync(join(dataDir(), "config.json"), '{ "embedding_presets": { "credentials": "${TENV_CORRUPT_REF}"');
    writeFileSync(join(dataDir(), "projects.json"), JSON.stringify([{ token: "${TENV_GOOD_REF}" }]));

    const r = filterDaemonEnv({ TENV_CORRUPT_REF: "c", TENV_GOOD_REF: "g" }, dataDir());
    expect(r.env).toEqual({ TENV_GOOD_REF: "g" });

    rmSync(join(dataDir(), "projects.json"));
    mkdirSync(join(dataDir(), "projects.json"));
    expect(filterDaemonEnv({ TENV_GOOD_REF: "g" }, dataDir()).env).toEqual({});
  });
});

// ─── escapeEnvFileValue ───────────────────────────────────────────────────────

/** Mimics systemd's double-quoted EnvironmentFile value rules: `\` escapes only `"`, `\`, `` ` `` and `$`. */
function parseQuotedEnvFileValue(s: string): string {
  if (!s.startsWith('"')) throw new Error(`not double-quoted: ${s}`);
  let out = "";
  for (let i = 1; i < s.length; i++) {
    const c = s[i]!;
    if (c === "\\") {
      const next = s[++i]!;
      out += '"\\`$'.includes(next) ? next : "\\" + next;
    } else if (c === '"') {
      if (i !== s.length - 1) throw new Error(`unescaped quote before the end: ${s}`);
      return out;
    } else {
      out += c;
    }
  }
  throw new Error(`unterminated: ${s}`);
}

describe("escapeEnvFileValue", () => {
  // The values a real systemd 255 unit round-tripped byte-exactly, with the escaper's expected output.
  const CASES: Array<[string, string, string]> = [
    ["V_PLAIN", "glpat-abc123", '"glpat-abc123"'],
    ["V_BS_TRAIL", "ends-with-backslash\\", '"ends-with-backslash\\\\"'],
    ["V_BS_MID", "c:\\path\\x", '"c:\\\\path\\\\x"'],
    ["V_DOLLAR", "x$HOME y${USER} $$", '"x\\$HOME y\\${USER} \\$\\$"'],
    ["V_DQ", 'say "hi"', '"say \\"hi\\""'],
    ["V_SQ", "it's", '"it\'s"'],
    ["V_BT", "a`b`", '"a\\`b\\`"'],
    ["V_TAB", "a\tb", '"a\tb"'],
    ["V_ESC", "a\x1bb", '"a\x1bb"'],
    ["V_HASH", "#lead", '"#lead"'],
    ["V_SEMI", ";lead", '";lead"'],
    ["V_EMPTY", "", '""'],
    ["V_SPACES", "  both  ", '"  both  "'],
    ["V_EQ", "k=v=w", '"k=v=w"'],
    ["V_UNI", "Привет ✓ 𝄞", '"Привет ✓ 𝄞"'],
    ["V_PCT", "100%h %%", '"100%h %%"'],
    ["V_BSN", "lit\\nnot-newline", '"lit\\\\nnot-newline"'],
  ];

  it.each(CASES)("%s escapes as expected and parses back to the original", async (_name, value, expected) => {
    const { escapeEnvFileValue } = await loadSpawn();
    const escaped = escapeEnvFileValue(value);
    expect(escaped).toBe(expected);
    expect(parseQuotedEnvFileValue(escaped)).toBe(value);
  });
});

// ─── buildSystemdRunArgs with an env file ─────────────────────────────────────

describe("buildSystemdRunArgs with envFile", () => {
  it("passes EnvironmentFile and puts no variable name or value in argv", async () => {
    const { buildSystemdRunArgs } = await loadSpawn();
    const args = buildSystemdRunArgs({
      node: "/usr/bin/node",
      script: "/opt/scrybe/dist/index.js",
      unitName: "scrybe-daemon-1-deadbeef.service",
      limitMb: 4096,
      env: { PATH: "/usr/bin", SCRYBE_EMBEDDING_API_KEY: "sk-must-never-appear" },
      envFile: "/run/user/1/scrybe/scrybe-daemon-1-deadbeef.service.env",
    });

    expect(args).toContain("EnvironmentFile=/run/user/1/scrybe/scrybe-daemon-1-deadbeef.service.env");
    expect(args.some((a) => a.startsWith("--setenv"))).toBe(false);
    const joined = args.join("\0");
    expect(joined).not.toContain("SCRYBE_EMBEDDING_API_KEY");
    expect(joined).not.toContain("sk-must-never-appear");
    expect(args.slice(-5)).toEqual(["--", "/usr/bin/node", "/opt/scrybe/dist/index.js", "daemon", "start"]);
  });
});

// ─── The env file's life: written 0600, gone once systemd-run returns ─────────

describe.skipIf(process.platform !== "linux")("daemon env file lifecycle", () => {
  let binDir: string;
  let runtimeDir: string;
  let logPath: string;
  const DAEMON_ARGV = ["/tmp/entry.js", "daemon", "start"];
  const SYSTEMD_RUN = () => join(binDir, "systemd-run");

  interface Seen { path: string; existed: boolean; mode: number; dirMode: number; body: string; existedAtExit?: boolean }

  function inspectEnvFile(args: string[]): Seen {
    const arg = args.find((a) => a.startsWith("EnvironmentFile="));
    if (!arg) throw new Error(`no EnvironmentFile in ${JSON.stringify(args)}`);
    const path = arg.slice("EnvironmentFile=".length);
    return {
      path,
      existed: existsSync(path),
      mode: statSync(path).mode & 0o777,
      dirMode: statSync(dirname(path)).mode & 0o777,
      body: readFileSync(path, "utf8"),
    };
  }

  function spawnEnv(extra: NodeJS.ProcessEnv = {}): NodeJS.ProcessEnv {
    return {
      PATH: binDir,
      XDG_RUNTIME_DIR: runtimeDir,
      SCRYBE_DATA_DIR: dataDir(),
      SCRYBE_TENV: 'a"b$c',
      UNRELATED_SECRET: "must-not-reach-the-daemon",
      ...extra,
    };
  }

  beforeEach(async () => {
    binDir = mkdtempSync(join(tmpdir(), "scrybe-envfile-bin-"));
    runtimeDir = mkdtempSync(join(tmpdir(), "scrybe-envfile-run-"));
    writeFileSync(join(binDir, "systemd-run"), "#!/bin/sh\nexit 0\n", { mode: 0o755 });
    logPath = join(mkdtempSync(join(tmpdir(), "scrybe-envfile-log-")), "daemon-log.jsonl");
    process.env["SCRYBE_DAEMON_LOG_PATH"] = logPath;

    const { EventEmitter } = await import("events");
    const { spawn, spawnSync } = await import("child_process");
    vi.mocked(spawn).mockReset();
    vi.mocked(spawnSync).mockReset();
    vi.mocked(spawn).mockImplementation((() => {
      const child = new EventEmitter() as any;
      child.pid = 4242;
      child.unref = vi.fn();
      child.kill = vi.fn();
      return child;
    }) as any);
  });

  afterEach(() => {
    delete process.env["SCRYBE_DAEMON_LOG_PATH"];
    for (const d of [binDir, runtimeDir, join(logPath, "..")]) rmSync(d, { recursive: true, force: true });
  });

  async function mockSyncRun(result: object): Promise<Seen[]> {
    const { spawnSync } = await import("child_process");
    const seen: Seen[] = [];
    vi.mocked(spawnSync).mockImplementation(((_cmd: string, args: string[]) => {
      seen.push(inspectEnvFile(args));
      return { signal: null, pid: 7, output: [], stdout: null, stderr: null, ...result };
    }) as any);
    return seen;
  }

  /** systemd-run settles with `code` on the next tick, or never when `code` is "hang". */
  async function mockAsyncRun(code: number | "hang"): Promise<Seen[]> {
    const { EventEmitter } = await import("events");
    const { spawn } = await import("child_process");
    const seen: Seen[] = [];
    vi.mocked(spawn).mockImplementation(((cmd: string, args: string[]) => {
      const child = new EventEmitter() as any;
      child.pid = 4242;
      child.unref = vi.fn();
      child.kill = vi.fn();
      if (cmd === SYSTEMD_RUN()) {
        const s = inspectEnvFile(args);
        seen.push(s);
        if (code !== "hang") {
          setImmediate(() => {
            s.existedAtExit = existsSync(s.path);
            child.emit("exit", code, null);
          });
        }
      }
      return child;
    }) as any);
    return seen;
  }

  async function callSync(env = spawnEnv(), extra: object = {}) {
    const { spawnDaemonDetached } = await loadSpawn();
    spawnDaemonDetached({ execPath: "/usr/bin/node", entryScript: "/tmp/entry.js", env, cgroupMaxMb: 512, ...extra });
  }

  async function callAsync(budgetMs = 5000) {
    const { spawnDaemonDetachedAsync } = await loadSpawn();
    await spawnDaemonDetachedAsync({
      execPath: "/usr/bin/node", entryScript: "/tmp/entry.js", env: spawnEnv(), cgroupMaxMb: 512, budgetMs,
    });
  }

  it("sync: the file exists (0600, dir 0700) while systemd-run runs and is gone after success", async () => {
    const { spawn, spawnSync } = await import("child_process");
    const seen = await mockSyncRun({ status: 0 });

    await callSync();

    expect(seen).toHaveLength(1);
    expect(seen[0]!.existed).toBe(true);
    expect(seen[0]!.mode).toBe(0o600);
    expect(seen[0]!.dirMode).toBe(0o700);
    expect(seen[0]!.path.startsWith(join(runtimeDir, "scrybe") + "/")).toBe(true);
    expect(existsSync(seen[0]!.path)).toBe(false);
    expect(vi.mocked(spawn)).not.toHaveBeenCalled();
    expect((vi.mocked(spawnSync).mock.calls[0]![1] as string[]).some((a) => a.startsWith("--setenv"))).toBe(false);
  });

  it("sync: the file carries the filtered env, escaped, with the arena caps", async () => {
    const seen = await mockSyncRun({ status: 0 });

    await callSync();

    const body = seen[0]!.body;
    expect(body).toContain('SCRYBE_TENV="a\\"b\\$c"\n');
    expect(body).toContain('MALLOC_ARENA_MAX="2"\n');
    expect(body).toContain(`PATH="${binDir}"\n`);
    expect(body).not.toContain("UNRELATED_SECRET");
    expect(body).not.toContain("must-not-reach-the-daemon");
  });

  it("sync: the file is gone after systemd-run exits non-zero, and the fallback gets the filtered env", async () => {
    const { spawn } = await import("child_process");
    const seen = await mockSyncRun({ status: 1 });

    await callSync();

    expect(seen[0]!.existed).toBe(true);
    expect(existsSync(seen[0]!.path)).toBe(false);
    expect(vi.mocked(spawn)).toHaveBeenCalledTimes(1);
    expect(vi.mocked(spawn).mock.calls[0]![1]).toEqual(DAEMON_ARGV);
    const fallbackEnv = (vi.mocked(spawn).mock.calls[0]![2] as any).env as NodeJS.ProcessEnv;
    expect(fallbackEnv["UNRELATED_SECRET"]).toBeUndefined();
    expect(fallbackEnv["SCRYBE_TENV"]).toBe('a"b$c');
    expect(fallbackEnv["MALLOC_ARENA_MAX"]).toBe("2");
  });

  it("sync: the file is gone after a timeout", async () => {
    const seen = await mockSyncRun({
      status: null, signal: "SIGKILL",
      error: Object.assign(new Error("spawnSync ETIMEDOUT"), { code: "ETIMEDOUT" }),
    });

    await callSync();

    expect(seen[0]!.existed).toBe(true);
    expect(existsSync(seen[0]!.path)).toBe(false);
  });

  it("async: the file exists while systemd-run runs and is gone after success", async () => {
    const { spawn } = await import("child_process");
    const seen = await mockAsyncRun(0);

    await callAsync();

    expect(seen).toHaveLength(1);
    expect(seen[0]!.existed).toBe(true);
    expect(seen[0]!.existedAtExit).toBe(true);
    expect(seen[0]!.mode).toBe(0o600);
    expect(existsSync(seen[0]!.path)).toBe(false);
    expect(vi.mocked(spawn)).toHaveBeenCalledTimes(1);
  });

  it("async: the file is gone after systemd-run exits non-zero", async () => {
    const { spawn } = await import("child_process");
    const seen = await mockAsyncRun(1);

    await callAsync();

    expect(seen[0]!.existedAtExit).toBe(true);
    expect(existsSync(seen[0]!.path)).toBe(false);
    expect(vi.mocked(spawn)).toHaveBeenCalledTimes(2);
    expect(vi.mocked(spawn).mock.calls[1]![1]).toEqual(DAEMON_ARGV);
  });

  it("async: the file is gone after a timeout", async () => {
    const seen = await mockAsyncRun("hang");

    await callAsync(1000);

    expect(seen[0]!.existed).toBe(true);
    expect(existsSync(seen[0]!.path)).toBe(false);
  });

  it("falls back to name-only --setenv when there is no runtime dir", async () => {
    const { spawnSync } = await import("child_process");
    vi.mocked(spawnSync).mockReturnValue({ status: 0, signal: null, pid: 7, output: [], stdout: null, stderr: null } as any);

    const env = spawnEnv({ DBUS_SESSION_BUS_ADDRESS: "unix:path=/nonexistent/bus" });
    delete env["XDG_RUNTIME_DIR"];
    await callSync(env);

    const args = vi.mocked(spawnSync).mock.calls[0]![1] as string[];
    expect(args.some((a) => a.startsWith("EnvironmentFile="))).toBe(false);
    expect(args).toContain("--setenv=SCRYBE_TENV");
    expect(args).not.toContain("--setenv=UNRELATED_SECRET");
    expect(args.join("\0")).not.toContain('a"b$c');
    expect(readFileSync(logPath, "utf8")).toContain('"reason":"no-runtime-dir"');
  });

  it("warns when the runtime dir is relative, and falls back", async () => {
    const { spawnSync } = await import("child_process");
    vi.mocked(spawnSync).mockReturnValue({ status: 0, signal: null, pid: 7, output: [], stdout: null, stderr: null } as any);

    await callSync(spawnEnv({ XDG_RUNTIME_DIR: "relative/run" }));

    const args = vi.mocked(spawnSync).mock.calls[0]![1] as string[];
    expect(args.some((a) => a.startsWith("EnvironmentFile="))).toBe(false);
    expect(readFileSync(logPath, "utf8")).toContain('"reason":"runtime-dir-not-absolute"');
  });

  it("falls back to --setenv when the file cannot be written", async () => {
    const { spawnSync } = await import("child_process");
    vi.mocked(spawnSync).mockReturnValue({ status: 0, signal: null, pid: 7, output: [], stdout: null, stderr: null } as any);
    writeFileSync(join(runtimeDir, "scrybe"), "a file where the directory should be");

    await callSync();

    const args = vi.mocked(spawnSync).mock.calls[0]![1] as string[];
    expect(args.some((a) => a.startsWith("EnvironmentFile="))).toBe(false);
    expect(args).toContain("--setenv=SCRYBE_TENV");
    expect(readFileSync(logPath, "utf8")).toContain('"event":"daemon.spawn.env-file-fallback"');
  });

  it("writes into the runtimeDir option when one is given", async () => {
    const other = mkdtempSync(join(tmpdir(), "scrybe-envfile-run2-"));
    try {
      const seen = await mockSyncRun({ status: 0 });
      await callSync(spawnEnv(), { runtimeDir: other });
      expect(seen[0]!.path.startsWith(join(other, "scrybe") + "/")).toBe(true);
      expect(existsSync(seen[0]!.path)).toBe(false);
    } finally {
      rmSync(other, { recursive: true, force: true });
    }
  });

  it("refuses a scrybe runtime dir that others can enter, or that is a symlink, and falls back", async () => {
    const { spawnSync } = await import("child_process");
    const { chmodSync, symlinkSync } = await import("fs");
    vi.mocked(spawnSync).mockReturnValue({ status: 0, signal: null, pid: 7, output: [], stdout: null, stderr: null } as any);

    mkdirSync(join(runtimeDir, "scrybe"), { mode: 0o700 });
    chmodSync(join(runtimeDir, "scrybe"), 0o755);
    await callSync();
    let args = vi.mocked(spawnSync).mock.calls[0]![1] as string[];
    expect(args.some((a) => a.startsWith("EnvironmentFile="))).toBe(false);

    const elsewhere = mkdtempSync(join(tmpdir(), "scrybe-envfile-elsewhere-"));
    try {
      rmSync(join(runtimeDir, "scrybe"), { recursive: true, force: true });
      symlinkSync(elsewhere, join(runtimeDir, "scrybe"));
      vi.mocked(spawnSync).mockClear();
      await callSync();
      args = vi.mocked(spawnSync).mock.calls[0]![1] as string[];
      expect(args.some((a) => a.startsWith("EnvironmentFile="))).toBe(false);
    } finally {
      rmSync(elsewhere, { recursive: true, force: true });
    }

    const reasons = readFileSync(logPath, "utf8").split("\n").filter(Boolean)
      .map((l) => JSON.parse(l)).filter((e) => e.event === "daemon.spawn.env-file-fallback").map((e) => e.reason);
    expect(reasons).toEqual(["runtime-dir-unsafe", "runtime-dir-unsafe"]);
  });

  it("logs one env-filtered event per spawn with counts and missing ref names, never values", async () => {
    const { spawnSync } = await import("child_process");
    vi.mocked(spawnSync).mockReturnValue({ status: 0, signal: null, pid: 7, output: [], stdout: null, stderr: null } as any);
    writeFileSync(join(dataDir(), "projects.json"), JSON.stringify([
      { token: "${TENV_PRESENT}" }, { token: "${TENV_ABSENT}" },
    ]));

    await callSync(spawnEnv({ TENV_PRESENT: "present-secret-value" }));

    const log = readFileSync(logPath, "utf8");
    const events = log.split("\n").filter(Boolean).map((l) => JSON.parse(l))
      .filter((e) => e.event === "daemon.spawn.env-filtered");
    expect(events).toHaveLength(1);
    expect(events[0].missingRefs).toEqual(["TENV_ABSENT"]);
    // PATH, XDG_RUNTIME_DIR, SCRYBE_DATA_DIR, SCRYBE_TENV, TENV_PRESENT and the two MALLOC_ defaults; UNRELATED_SECRET dropped.
    expect(events[0].kept).toBe(7);
    expect(events[0].dropped).toBe(1);
    expect(log).not.toContain("present-secret-value");
    expect(log).not.toContain("must-not-reach-the-daemon");
  });
});

// ─── The unset-${VAR} error inside the daemon names the remedy ────────────────

describe("unset ${VAR} error message", () => {
  const PREFIX = "env var TENV_NOPE not set (referenced in scrybe config)";

  it("is unchanged outside the daemon", async () => {
    delete process.env["TENV_NOPE"];
    const { resolveEnvRef } = await import("../src/config.js");
    let msg = "";
    try { resolveEnvRef("${TENV_NOPE}"); } catch (err) { msg = (err as Error).message; }
    expect(msg).toBe(PREFIX);
  });

  it("keeps its prefix and names the remedy inside the daemon", async () => {
    delete process.env["TENV_NOPE"];
    const { resolveEnvRef, markDaemonProcess } = await import("../src/config.js");
    markDaemonProcess();

    let thrown: unknown;
    try { resolveEnvRef("${TENV_NOPE}"); } catch (err) { thrown = err; }
    const msg = (thrown as Error).message;
    const { isCallerFacing } = await import("../src/daemon/caller-error.js");

    // The daemon's RPC layer echoes only caller-facing errors; anything else reaches the client as "internal error".
    expect(isCallerFacing(thrown)).toBe(true);
    expect(msg.startsWith(PREFIX)).toBe(true);
    expect(msg).toContain("scrybe daemon stop");
    expect(msg).toContain("<DATA_DIR>/.env");
    expect(msg).not.toContain(dataDir());
    if (process.platform === "linux") expect(msg).toContain("SCRYBE_DAEMON_ENV_PASSTHROUGH");
    // ticket-poller.ts classifies the error by these substrings.
    expect(msg.includes("not set") && msg.includes("env var")).toBe(true);
  });

  it("is carried by the ticket plugins' token validation inside the daemon", async () => {
    delete process.env["TENV_NOPE"];
    const { markDaemonProcess } = await import("../src/config.js");
    const { validateGitlabToken } = await import("../src/plugins/gitlab-issues.js");
    const { validateGithubToken } = await import("../src/plugins/github-issues.js");
    markDaemonProcess();
    const cfg = { type: "ticket", provider: "gitlab", project_id: "p", base_url: "http://127.0.0.1:1", token: "${TENV_NOPE}" } as any;

    await expect(validateGitlabToken(cfg)).rejects.toThrow(/references env var TENV_NOPE which is not set.*scrybe daemon stop/s);
    await expect(validateGithubToken(cfg)).rejects.toThrow(/references env var TENV_NOPE which is not set.*scrybe daemon stop/s);
    const { isCallerFacing } = await import("../src/daemon/caller-error.js");
    for (const validate of [validateGitlabToken, validateGithubToken]) {
      const err = await validate(cfg).then(() => null, (e: unknown) => e);
      expect(isCallerFacing(err)).toBe(true);
      // The source is not saved until its token resolves, so a bare daemon restart cannot help.
      if (process.platform === "linux") {
        const msg = (err as Error).message;
        expect(msg).toContain("restarting it alone won't help");
        expect(msg).toContain("SCRYBE_<something>");
        expect(msg).toContain("SCRYBE_DAEMON_ENV_PASSTHROUGH");
        expect(msg).toContain("scrybe source add");
      }
    }
  });
});

// ─── sweepStaleEnvFiles ───────────────────────────────────────────────────────

describe("sweepStaleEnvFiles", () => {
  it("removes only scrybe env files older than a minute, and never follows a symlink", async () => {
    const { sweepStaleEnvFiles } = await loadSpawn();
    const { utimesSync, symlinkSync } = await import("fs");
    const dir = mkdtempSync(join(tmpdir(), "scrybe-sweep-"));
    try {
      const old = join(dir, "scrybe-daemon-1-aa.service.env");
      const fresh = join(dir, "scrybe-daemon-2-bb.service.env");
      const other = join(dir, "notes.env");
      const target = join(dir, "target.txt");
      const link = join(dir, "scrybe-daemon-3-cc.service.env");
      for (const p of [old, fresh, other, target]) writeFileSync(p, "X=1\n");
      symlinkSync(target, link);
      const now = Date.now();
      const twoMinutesAgo = (now - 120_000) / 1000;
      for (const p of [old, other, target]) utimesSync(p, twoMinutesAgo, twoMinutesAgo);

      sweepStaleEnvFiles(dir, now);

      expect(existsSync(old)).toBe(false);
      expect(existsSync(fresh)).toBe(true);
      expect(existsSync(other)).toBe(true);
      expect(existsSync(target)).toBe(true);
      expect(existsSync(link)).toBe(true);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
