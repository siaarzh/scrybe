//! Starting a server in the background. Mirrors `src/daemon/spawn-detached.ts`: on Linux the server gets only the
//! environment it needs and, where a systemd user session answers, a memory cap the kernel enforces.
use crate::config::data_dir;
use crate::jobs::diag;
use crate::jsstr::parse_int;
use serde_json::json;
use std::collections::BTreeSet;
use std::ffi::OsString;
use std::process::{Command, Stdio};
use std::time::Duration;

type Env = Vec<(OsString, OsString)>;

/// The allocator reads these when the process starts; a value already set wins.
fn with_arena_caps(mut env: Env) -> Env {
    for (name, value) in [("MALLOC_ARENA_MAX", "2"), ("MALLOC_TRIM_THRESHOLD_", "131072")] {
        if !env.iter().any(|(k, _)| k == name) {
            env.push((name.into(), value.into()));
        }
    }
    env
}

/// Starts `serve` on its own. `budget` is what's left of the caller's wait.
pub fn spawn_server(budget: Duration) -> std::io::Result<()> {
    let program = std::env::current_exe()?;
    let env = with_arena_caps(std::env::vars_os().collect());
    #[cfg(target_os = "linux")]
    let env = {
        let filtered = filter_env(env, &data_dir());
        diag(json!({ "event": "daemon.spawn.env-filtered", "level": "info", "kept": filtered.kept, "dropped": filtered.dropped, "missingRefs": filtered.missing_refs }));
        if linux::spawn_capped(&program, &filtered.env, budget) {
            return Ok(());
        }
        filtered.env
    };
    #[cfg(not(target_os = "linux"))]
    let _ = budget;
    spawn_plain(&program, env)
}

fn spawn_plain(program: &std::path::Path, env: Env) -> std::io::Result<()> {
    let mut cmd = Command::new(program);
    cmd.arg("serve").env_clear().envs(env).stdin(Stdio::null()).stdout(Stdio::null()).stderr(Stdio::null());
    #[cfg(unix)]
    {
        use std::os::unix::process::CommandExt;
        cmd.process_group(0);
    }
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        cmd.creation_flags(0x0800_0000 | 0x0000_0200);
        stop_inheriting_std_handles();
    }
    let child = cmd.spawn()?;
    diag(json!({ "event": "child-process.spawn", "level": "info", "pid": child.id(), "ppid": std::process::id(), "command": program.to_string_lossy(), "args": ["serve"], "detached": true }));
    Ok(())
}

/// On Windows a child inherits every inheritable handle, so it would hold this process's own output pipes open after it exits.
#[cfg(windows)]
fn stop_inheriting_std_handles() {
    use windows_sys::Win32::Foundation::{SetHandleInformation, HANDLE_FLAG_INHERIT, INVALID_HANDLE_VALUE};
    use windows_sys::Win32::System::Console::{GetStdHandle, STD_ERROR_HANDLE, STD_INPUT_HANDLE, STD_OUTPUT_HANDLE};
    for id in [STD_INPUT_HANDLE, STD_OUTPUT_HANDLE, STD_ERROR_HANDLE] {
        // SAFETY: the handles are this process's own standard ones.
        unsafe {
            let handle = GetStdHandle(id);
            if !handle.is_null() && handle != INVALID_HANDLE_VALUE {
                SetHandleInformation(handle, HANDLE_FLAG_INHERIT, 0);
            }
        }
    }
}

// ─── What the server inherits ────────────────────────────────────────────────

const FORWARD_PREFIXES: [&str; 17] = [
    "SCRYBE_", "MALLOC_", "LC_", "XDG_", "GIT_", "NODE_", "OPENSSL_", "LANCE_", "LANCEDB_", "HF_", "NAPI_RS_", "TOKIO_", "ORT_", "ONNXRUNTIME_", "GCM_", "RAYON_",
    "npm_config_",
];

/// Prefixed names that redirect the server's own git calls, or are an npm publish credential.
const PREFIX_EXCEPTIONS: [&str; 4] = ["GIT_DIR", "GIT_WORK_TREE", "GIT_INDEX_FILE", "NODE_AUTH_TOKEN"];

const FORWARD_EXACT: [&str; 46] = [
    "PATH", "HOME", "USER", "LOGNAME", "SHELL", "LANG", "LANGUAGE", "TZ", "TMPDIR", "TEMP", "TMP", "SSH_AUTH_SOCK", "SSH_ASKPASS", "KRB5CCNAME",
    "DBUS_SESSION_BUS_ADDRESS", "DEBUG", "UV_THREADPOOL_SIZE", "SSL_CERT_FILE", "SSL_CERT_DIR", "HTTP_PROXY", "HTTPS_PROXY", "NO_PROXY", "ALL_PROXY", "http_proxy",
    "https_proxy", "no_proxy", "all_proxy", "OPENAI_BASE_URL", "OPENAI_ORG_ID", "OPENAI_PROJECT_ID", "OPENAI_LOG", "CI", "WSL_DISTRO_NAME", "NO_UPDATE_NOTIFIER",
    "RUST_LOG", "RUST_BACKTRACE", "RUST_LIB_BACKTRACE", "RUST_MIN_STACK", "OMP_NUM_THREADS", "UV_USE_IO_URING", "ELECTRON_RUN_AS_NODE", "LD_LIBRARY_PATH", "LD_PRELOAD",
    "GLIBC_TUNABLES", "NIX_LD", "NIX_LD_LIBRARY_PATH",
];

/// Resolved preset credentials a process puts in its own environment; the server rebuilds them.
const NEVER_FORWARD_PREFIX: &str = "SCRYBE_PRESET_";

fn looks_like_a_credential(name: &str) -> bool {
    let upper = name.to_ascii_uppercase();
    ["TOKEN", "PASSWORD", "PASSWD", "SECRET", "API_KEY", "ACCESS_KEY", "PRIVATE_KEY"].iter().any(|w| upper.contains(w))
}

fn is_npm_credential(name: &str) -> bool {
    let lower = name.to_ascii_lowercase();
    lower.strip_prefix("npm_config_").is_some_and(|rest| ["auth", "token", "pass", "cert", "key"].iter().any(|w| rest.contains(w)))
}

fn forwards(name: &str, refs: &BTreeSet<String>, passthrough: &BTreeSet<String>) -> bool {
    if name.starts_with(NEVER_FORWARD_PREFIX) {
        return false;
    }
    if FORWARD_EXACT.contains(&name) || refs.contains(name) || passthrough.contains(name) {
        return true;
    }
    if PREFIX_EXCEPTIONS.contains(&name) || is_npm_credential(name) {
        return false;
    }
    if !name.starts_with("SCRYBE_") && looks_like_a_credential(name) {
        return false;
    }
    FORWARD_PREFIXES.iter().any(|p| name.starts_with(p))
}

/// Every `${VAR}` name in the raw text of the data dir's config.json and projects.json.
pub fn config_env_refs(dir: &std::path::Path) -> BTreeSet<String> {
    let mut refs = BTreeSet::new();
    let Ok(re) = regex::Regex::new(crate::registry::ENV_REF) else { return refs };
    for file in ["config.json", "projects.json"] {
        let Ok(text) = std::fs::read_to_string(dir.join(file)) else { continue };
        if serde_json::from_str::<serde_json::Value>(&text).is_err() {
            continue;
        }
        refs.extend(re.captures_iter(&text).map(|c| c[1].to_string()));
    }
    refs
}

fn passthrough_from(raw: &str) -> BTreeSet<String> {
    raw.split(|c: char| c.is_whitespace() || c == ',').filter(|n| !n.is_empty()).map(String::from).collect()
}

/// Whether a started server gets `name` whatever the config references.
pub fn server_keeps(name: &str) -> bool {
    forwards(name, &BTreeSet::new(), &passthrough_from(&std::env::var("SCRYBE_DAEMON_ENV_PASSTHROUGH").unwrap_or_default()))
}

pub struct Filtered {
    pub env: Env,
    pub kept: usize,
    pub dropped: usize,
    /// `${VAR}` names the config references that the starter's environment lacks.
    pub missing_refs: Vec<String>,
}

pub fn filter_env(env: Env, dir: &std::path::Path) -> Filtered {
    let refs = config_env_refs(dir);
    let passthrough = env.iter().find(|(k, _)| k == "SCRYBE_DAEMON_ENV_PASSTHROUGH").map(|(_, v)| passthrough_from(&v.to_string_lossy())).unwrap_or_default();
    let missing_refs = refs.iter().filter(|name| !env.iter().any(|(k, _)| k == name.as_str())).cloned().collect();
    let total = env.len();
    let env: Env = env.into_iter().filter(|(k, _)| k.to_str().is_some_and(|k| forwards(k, &refs, &passthrough))).collect();
    Filtered { kept: env.len(), dropped: total - env.len(), env, missing_refs }
}

/// What a live process was started with: `Gone` when there is no such process, `Unreadable` when it can't be read.
#[derive(Debug, PartialEq)]
pub enum ProcessNames {
    Gone,
    Unreadable,
    Names(BTreeSet<String>),
}

/// Variable names only, never values.
pub fn process_env_names(pid: i64) -> ProcessNames {
    match std::fs::read(format!("/proc/{pid}/environ")) {
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => ProcessNames::Gone,
        Err(_) => ProcessNames::Unreadable,
        Ok(raw) => ProcessNames::Names(raw.split(|b| *b == 0).filter(|e| !e.is_empty()).map(|e| String::from_utf8_lossy(e.split(|b| *b == b'=').next().unwrap_or(e)).into_owned()).collect()),
    }
}

// ─── The memory cap ──────────────────────────────────────────────────────────

const CAP_MARGIN_MB: i64 = 1024;

/// The cap in MB, 0 for none, and a warning when it had to be lifted above the in-process guard's ceiling.
fn cap_mb(cap: Option<&str>, hard: Option<&str>) -> (i64, Option<String>) {
    let number = |raw: &str| parse_int(raw).filter(|n| n.is_finite()).map(|n| n as i64);
    let configured = number(cap.unwrap_or("4096")).unwrap_or(0);
    if configured <= 0 {
        return (0, None);
    }
    let hard = match number(hard.unwrap_or("")) {
        Some(0) => 0,
        Some(n) if n > 0 => n,
        _ => 3072,
    };
    if hard == 0 || configured > hard {
        return (configured, None);
    }
    let adjusted = hard + CAP_MARGIN_MB;
    (adjusted, Some(format!("scrybe: SCRYBE_DAEMON_CGROUP_MAX_MB ({configured} MB) is at or below SCRYBE_DAEMON_MAX_RSS_HARD_MB ({hard} MB) — every ordinary over-budget excursion would be a kernel OOM kill instead of the in-process guard's clean self-restart. Using {adjusted} MB (hard ceiling + {CAP_MARGIN_MB} MB headroom) for this run instead of refusing to start. Fix SCRYBE_DAEMON_CGROUP_MAX_MB (or SCRYBE_DAEMON_MAX_RSS_HARD_MB) in your .env to silence this.\n")))
}

#[cfg(target_os = "linux")]
mod linux {
    use super::*;
    use std::io::Write;
    use std::os::unix::fs::{DirBuilderExt, MetadataExt, OpenOptionsExt};
    use std::os::unix::process::ExitStatusExt;
    use std::path::{Path, PathBuf};
    use std::time::{Instant, SystemTime};

    const FULL_TIMEOUT: Duration = Duration::from_secs(10);
    const MIN_TIMEOUT: Duration = Duration::from_millis(250);
    const STALE_ENV_FILE: Duration = Duration::from_secs(60);

    /// A share of what the caller has left; the rest is for waiting until the server answers.
    pub(super) fn wrapper_timeout(budget: Duration) -> Duration {
        budget.mul_f64(0.3).max(MIN_TIMEOUT).min(FULL_TIMEOUT)
    }

    fn lookup<'a>(env: &'a Env, name: &str) -> Option<&'a OsString> {
        env.iter().find(|(k, _)| k == name).map(|(_, v)| v).filter(|v| !v.is_empty())
    }

    pub(super) fn cap_plan(env: &Env, cap: i64) -> Result<(PathBuf, i64), &'static str> {
        if cap <= 0 {
            return Err("disabled-by-config");
        }
        if lookup(env, "DBUS_SESSION_BUS_ADDRESS").is_none() && lookup(env, "XDG_RUNTIME_DIR").is_none() {
            return Err("no-user-bus");
        }
        let path = lookup(env, "PATH").cloned().unwrap_or_default();
        let found = std::env::split_paths(&path).filter(|d| !d.as_os_str().is_empty()).map(|d| d.join("systemd-run")).find(|p| p.exists());
        found.map(|p| (p, cap)).ok_or("systemd-run-not-found")
    }

    /// What systemd sets for a unit itself; the starter's copies would lie to the server.
    const SYSTEMD_OWNED: [&str; 11] = ["INVOCATION_ID", "JOURNAL_STREAM", "LISTEN_FDNAMES", "LISTEN_FDS", "LISTEN_PID", "MAINPID", "MANAGERPID", "NOTIFY_SOCKET", "SYSTEMD_EXEC_PID", "WATCHDOG_PID", "WATCHDOG_USEC"];

    /// What a unit can be given. Leaving one variable out beats failing the whole start.
    pub(super) fn unit_entries(env: &Env) -> Vec<(&str, &str)> {
        let named = |k: &str| k.starts_with(|c: char| c.is_ascii_alphabetic() || c == '_') && k.chars().all(|c| c.is_ascii_alphanumeric() || c == '_');
        env.iter()
            .filter_map(|(k, v)| Some((k.to_str()?, v.to_str()?)))
            .filter(|(k, v)| !SYSTEMD_OWNED.contains(k) && named(k) && !v.contains(['\0', '\n', '\r']))
            .collect()
    }

    /// Quoted for an EnvironmentFile, where nothing is expanded.
    pub(super) fn escape_value(v: &str) -> String {
        let mut out = String::from("\"");
        for c in v.chars() {
            if matches!(c, '\\' | '"' | '`' | '$') {
                out.push('\\');
            }
            out.push(c);
        }
        out.push('"');
        out
    }

    /// Env files a starter killed half-way left behind.
    pub(super) fn sweep_stale(dir: &Path, now: SystemTime) {
        for entry in std::fs::read_dir(dir).into_iter().flatten().flatten() {
            let name = entry.file_name().to_string_lossy().into_owned();
            let ours = name.strip_prefix("scrybe-daemon-").and_then(|r| r.strip_suffix(".env")).is_some_and(|m| !m.is_empty() && m.chars().all(|c| c.is_ascii_alphanumeric() || "_.-".contains(c)));
            let Ok(meta) = std::fs::symlink_metadata(entry.path()) else { continue };
            let old = meta.modified().ok().and_then(|m| now.duration_since(m).ok()).is_some_and(|age| age > STALE_ENV_FILE);
            if ours && meta.is_file() && old {
                let _ = std::fs::remove_file(entry.path());
            }
        }
    }

    fn errno_name(e: &std::io::Error) -> String {
        let known = match e.raw_os_error() {
            Some(libc::EACCES) => "EACCES",
            Some(libc::EPERM) => "EPERM",
            Some(libc::ENOENT) => "ENOENT",
            Some(libc::ENOTDIR) => "ENOTDIR",
            Some(libc::EEXIST) => "EEXIST",
            Some(libc::EROFS) => "EROFS",
            Some(libc::ENOSPC) => "ENOSPC",
            _ => return e.to_string(),
        };
        known.to_string()
    }

    /// `<runtime dir>/scrybe/<unit>.env`, private to this user; an error is why names go on the command line instead.
    pub(super) fn write_env_file(runtime_dir: Option<&OsString>, unit: &str, env: &Env) -> Result<PathBuf, String> {
        let Some(base) = runtime_dir else { return Err("no-runtime-dir".into()) };
        if !Path::new(base).is_absolute() {
            return Err("runtime-dir-not-absolute".into());
        }
        let dir = Path::new(base).join("scrybe");
        let path = dir.join(format!("{unit}.env"));
        std::fs::DirBuilder::new().recursive(true).mode(0o700).create(&dir).map_err(|e| errno_name(&e))?;
        let meta = std::fs::symlink_metadata(&dir).map_err(|e| errno_name(&e))?;
        // SAFETY: getuid can't fail.
        if !meta.is_dir() || meta.uid() != unsafe { libc::getuid() } || meta.mode() & 0o077 != 0 {
            return Err("runtime-dir-unsafe".into());
        }
        sweep_stale(&dir, SystemTime::now());
        let body: String = unit_entries(env).iter().map(|(k, v)| format!("{k}={}\n", escape_value(v))).collect();
        let mut file = std::fs::OpenOptions::new().write(true).create_new(true).mode(0o600).open(&path).map_err(|e| errno_name(&e))?;
        file.write_all(body.as_bytes()).map_err(|e| {
            let _ = std::fs::remove_file(&path);
            errno_name(&e)
        })?;
        Ok(path)
    }

    pub(super) struct Launch<'a> {
        pub unit: &'a str,
        pub limit_mb: i64,
        pub program: &'a Path,
        pub env: &'a Env,
        pub working_dir: Option<&'a Path>,
        pub env_file: Option<&'a Path>,
    }

    pub(super) fn systemd_args(l: &Launch) -> Vec<OsString> {
        let prop = |p: OsString| [OsString::from("-p"), p];
        let mut args: Vec<OsString> = ["--user", "--quiet", "--collect"].map(OsString::from).to_vec();
        args.push(format!("--unit={}", l.unit).into());
        args.push("--description=scrybe daemon (memory-capped)".into());
        // KillMode=process: a replacement started from inside this unit must outlive it.
        for p in [format!("MemoryMax={}M", l.limit_mb), "MemorySwapMax=0".into(), "Restart=no".into(), "KillMode=process".into()] {
            args.extend(prop(p.into()));
        }
        let joined = |name: &str, path: &Path| {
            let mut s = OsString::from(name);
            s.push(path);
            s
        };
        if let Some(dir) = l.working_dir {
            args.extend(prop(joined("WorkingDirectory=-", dir)));
        }
        match l.env_file {
            Some(file) => args.extend(prop(joined("EnvironmentFile=", file))),
            None => args.extend(unit_entries(l.env).iter().map(|(k, _)| OsString::from(format!("--setenv={k}")))),
        }
        args.push("--".into());
        args.push(l.program.into());
        args.push("serve".into());
        args
    }

    fn wait(child: &mut std::process::Child, timeout: Duration) -> std::io::Result<Option<std::process::ExitStatus>> {
        let end = Instant::now() + timeout;
        loop {
            if let Some(status) = child.try_wait()? {
                return Ok(Some(status));
            }
            if Instant::now() >= end {
                let _ = child.kill();
                let _ = child.wait();
                return Ok(None);
            }
            std::thread::sleep(Duration::from_millis(5));
        }
    }

    /// Starts the server in a transient user service. False means nothing was started and a plain start is next.
    pub(super) fn spawn_capped(program: &Path, env: &Env, budget: Duration) -> bool {
        let var = |name: &str| std::env::var(name).ok();
        let (cap, warning) = cap_mb(var("SCRYBE_DAEMON_CGROUP_MAX_MB").as_deref(), var("SCRYBE_DAEMON_MAX_RSS_HARD_MB").as_deref());
        if let Some(w) = warning {
            eprint!("{w}");
        }
        let (systemd_run, limit_mb) = match cap_plan(env, cap) {
            Ok(plan) => plan,
            Err(reason) => {
                diag(json!({ "event": "daemon.cgroup-cap.skipped", "level": "debug", "reason": reason }));
                return false;
            }
        };
        let unit = format!("scrybe-daemon-{}-{}.service", std::process::id(), crate::jobs::random_id());
        let timeout = wrapper_timeout(budget);
        let runtime_dir = env.iter().find(|(k, _)| k == "XDG_RUNTIME_DIR").map(|(_, v)| v).filter(|v| !v.is_empty());
        let env_file = match write_env_file(runtime_dir, &unit, env) {
            Ok(path) => Some(path),
            Err(reason) => {
                diag(json!({ "event": "daemon.spawn.env-file-fallback", "level": "warn", "unit": unit, "reason": reason }));
                None
            }
        };
        let cwd = std::env::current_dir().ok();
        let args = systemd_args(&Launch { unit: &unit, limit_mb, program, env, working_dir: cwd.as_deref(), env_file: env_file.as_deref() });
        diag(json!({
            "event": "child-process.spawn", "level": "info", "pid": null, "ppid": std::process::id(), "command": systemd_run.to_string_lossy(),
            "args": ["--user", format!("--unit={unit}"), format!("MemoryMax={limit_mb}M"), program.to_string_lossy(), "serve"],
            "detached": true, "unit": unit, "memoryMaxMb": limit_mb, "timeoutMs": timeout.as_millis() as u64, "envVia": if env_file.is_some() { "environment-file" } else { "setenv" },
        }));
        let decline = |why: String| {
            diag(json!({ "event": "daemon.cgroup-cap.fallback", "level": "warn", "unit": unit, "reason": why }));
            false
        };
        let spawned = Command::new(&systemd_run).args(args).env_clear().envs(env.iter().cloned()).stdin(Stdio::null()).stdout(Stdio::null()).stderr(Stdio::null()).spawn();
        let ended = spawned.and_then(|mut child| wait(&mut child, timeout));
        // systemd has read the file by the time systemd-run returns.
        if let Some(path) = &env_file {
            let _ = std::fs::remove_file(path);
        }
        let status = match ended {
            Err(e) => return decline(format!("spawn-error: {e}")),
            Ok(None) => return decline("spawn-error: ETIMEDOUT".into()),
            Ok(Some(status)) => status,
        };
        let signal = status.signal().map(|s| format!("signal {s}"));
        diag(json!({ "event": "child-process.exit", "level": "info", "pid": null, "ppid": std::process::id(), "exitCode": status.code(), "signal": signal, "unit": unit }));
        if status.success() {
            return true;
        }
        decline(format!("systemd-run exited {}", status.code().map(|c| c.to_string()).or(signal).unwrap_or_default()))
    }
}

/// What a start from here would do about the memory cap, for the server's own log.
pub fn cap_prediction() -> serde_json::Value {
    #[cfg(target_os = "linux")]
    {
        let var = |name: &str| std::env::var(name).ok();
        let (cap, _) = cap_mb(var("SCRYBE_DAEMON_CGROUP_MAX_MB").as_deref(), var("SCRYBE_DAEMON_MAX_RSS_HARD_MB").as_deref());
        match linux::cap_plan(&std::env::vars_os().collect(), cap) {
            Ok((path, limit)) => json!({ "mode": "capped", "wrapper": "systemd-run", "limitMb": limit, "systemdRunPath": path.to_string_lossy() }),
            Err(reason) => json!({ "mode": "uncapped", "reason": reason }),
        }
    }
    #[cfg(not(target_os = "linux"))]
    json!({ "mode": "uncapped", "reason": "not-linux" })
}

#[cfg(test)]
mod tests {
    use super::*;

    fn env(pairs: &[(&str, &str)]) -> Env {
        pairs.iter().map(|(k, v)| (OsString::from(k), OsString::from(v))).collect()
    }

    fn names(f: &Filtered) -> Vec<&str> {
        f.env.iter().filter_map(|(k, _)| k.to_str()).collect()
    }

    fn scratch(name: &str) -> std::path::PathBuf {
        let dir = std::env::temp_dir().join(format!("scrybe-spawn-{}-{name}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).unwrap();
        dir
    }

    #[test]
    fn the_allowed_names_and_families_are_kept() {
        let all = [
            "PATH", "HOME", "LANG", "SSH_AUTH_SOCK", "SSH_ASKPASS", "KRB5CCNAME", "DEBUG", "NODE_OPTIONS", "NODE_EXTRA_CA_CERTS", "HTTPS_PROXY", "http_proxy", "OPENAI_BASE_URL", "LD_PRELOAD",
            "OPENSSL_CONF", "CI", "RUST_LOG", "SCRYBE_DATA_DIR", "MALLOC_ARENA_MAX", "LC_ALL", "XDG_RUNTIME_DIR", "GIT_SSH_COMMAND", "LANCE_IO_THREADS", "LANCEDB_LOG", "HF_HOME", "TOKIO_WORKER_THREADS",
            "ORT_LOGGING_LEVEL", "ONNXRUNTIME_X", "GCM_CREDENTIAL_STORE", "RAYON_NUM_THREADS", "npm_config_cache", "npm_config_registry", "SCRYBE_GITLAB_TOKEN",
        ];
        let f = filter_env(all.iter().map(|k| (OsString::from(k), OsString::from("v"))).collect(), std::path::Path::new("/nonexistent"));
        assert_eq!(names(&f), all);
        assert_eq!((f.kept, f.dropped), (all.len(), 0));
    }

    #[test]
    fn everything_else_is_dropped_credentials_of_unrelated_systems_first() {
        let f = filter_env(
            env(&[
                ("PATH", "/usr/bin"), ("AWS_SECRET_ACCESS_KEY", "x"), ("GH_TOKEN", "x"), ("EDITOR", "vim"), ("OPENAI_API_KEY", "x"), ("NODE_AUTH_TOKEN", "x"), ("HF_TOKEN", "x"), ("GIT_TOKEN", "x"),
                ("LANCE_AWS_SECRET_ACCESS_KEY", "x"), ("npm_config__authToken", "x"), ("npm_config_//registry.npmjs.org/:_password", "x"), ("GIT_DIR", "x"), ("GIT_WORK_TREE", "x"), ("GIT_INDEX_FILE", "x"),
                ("SCRYBE_PRESET_FOO", "x"),
            ]),
            std::path::Path::new("/nonexistent"),
        );
        assert_eq!(names(&f), ["PATH"]);
        assert_eq!((f.kept, f.dropped), (1, 14));
    }

    #[test]
    fn config_references_and_the_passthrough_list_bring_names_back() {
        let dir = scratch("refs");
        std::fs::write(dir.join("config.json"), r#"{"presets":{"a":{"key":"${GIT_TOKEN}"}}}"#).unwrap();
        std::fs::write(dir.join("projects.json"), r#"[{"token":"${MISSING_PAT}"}]"#).unwrap();
        let f = filter_env(env(&[("GIT_TOKEN", "g"), ("HF_TOKEN", "h"), ("GH_TOKEN", "x"), ("SCRYBE_PRESET_X", "p"), ("SCRYBE_DAEMON_ENV_PASSTHROUGH", "HF_TOKEN, SCRYBE_PRESET_X")]), &dir);
        assert_eq!(names(&f), ["GIT_TOKEN", "HF_TOKEN", "SCRYBE_DAEMON_ENV_PASSTHROUGH"]);
        assert_eq!(f.missing_refs, ["MISSING_PAT"]);
        std::fs::write(dir.join("config.json"), r#"{ "key": "${GIT_TOKEN}""#).unwrap();
        assert_eq!(config_env_refs(&dir).into_iter().collect::<Vec<_>>(), ["MISSING_PAT"], "a corrupt file gives no references");
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn the_arena_caps_are_added_and_a_set_value_wins() {
        assert_eq!(with_arena_caps(env(&[("MALLOC_ARENA_MAX", "4")])), env(&[("MALLOC_ARENA_MAX", "4"), ("MALLOC_TRIM_THRESHOLD_", "131072")]));
    }

    #[test]
    fn the_cap_sits_above_the_in_process_ceiling() {
        assert_eq!(cap_mb(None, None), (4096, None));
        assert_eq!(cap_mb(Some("0"), None), (0, None));
        assert_eq!(cap_mb(Some("junk"), None), (0, None));
        assert_eq!(cap_mb(Some("2048"), Some("0")), (2048, None));
        let (mb, warning) = cap_mb(Some("3072"), None);
        assert_eq!(mb, 4096);
        assert!(warning.unwrap().contains("at or below SCRYBE_DAEMON_MAX_RSS_HARD_MB (3072 MB)"));
        assert_eq!(cap_mb(Some("\u{feff} 5000abc"), Some("-7")), (5000, None));
    }

    #[cfg(target_os = "linux")]
    mod linux_only {
        use super::super::linux::*;
        use super::*;
        use std::os::unix::fs::PermissionsExt;
        use std::time::SystemTime;

        #[test]
        fn a_capped_start_asks_systemd_for_exactly_today_s_properties() {
            let e = env(&[("PATH", "/usr/bin"), ("SECRET", "no-values-here"), ("INVOCATION_ID", "x"), ("BAD-NAME", "x"), ("NL", "a\nb")]);
            let base = Launch { unit: "u.service", limit_mb: 4096, program: std::path::Path::new("/opt/scrybe"), env: &e, working_dir: Some(std::path::Path::new("/w")), env_file: None };
            let text = |l: &Launch| systemd_args(l).iter().map(|a| a.to_string_lossy().into_owned()).collect::<Vec<_>>().join(" ");
            assert_eq!(text(&base), "--user --quiet --collect --unit=u.service --description=scrybe daemon (memory-capped) -p MemoryMax=4096M -p MemorySwapMax=0 -p Restart=no -p KillMode=process -p WorkingDirectory=-/w --setenv=PATH --setenv=SECRET -- /opt/scrybe serve");
            let filed = text(&Launch { env_file: Some(std::path::Path::new("/run/x.env")), working_dir: None, ..base });
            assert!(filed.ends_with("-p KillMode=process -p EnvironmentFile=/run/x.env -- /opt/scrybe serve"), "{filed}");
        }

        #[test]
        fn the_env_file_is_private_escaped_and_never_shared() {
            let dir = scratch("envfile");
            let e = env(&[("A", r#"q"b\s$v`t"#), ("NOTIFY_SOCKET", "x")]);
            let path = write_env_file(Some(&dir.clone().into_os_string()), "scrybe-daemon-1-a.service", &e).unwrap();
            assert_eq!(std::fs::read_to_string(&path).unwrap(), "A=\"q\\\"b\\\\s\\$v\\`t\"\n");
            assert_eq!(std::fs::metadata(&path).unwrap().permissions().mode() & 0o777, 0o600);
            assert_eq!(std::fs::metadata(path.parent().unwrap()).unwrap().permissions().mode() & 0o777, 0o700);
            assert_eq!(write_env_file(Some(&dir.clone().into_os_string()), "scrybe-daemon-1-a.service", &e).unwrap_err(), "EEXIST");
            assert!(path.exists(), "a file that was there first is not ours to remove");
            std::fs::set_permissions(dir.join("scrybe"), std::fs::Permissions::from_mode(0o755)).unwrap();
            assert_eq!(write_env_file(Some(&dir.clone().into_os_string()), "u2", &e).unwrap_err(), "runtime-dir-unsafe");
            assert_eq!(write_env_file(None, "u", &e).unwrap_err(), "no-runtime-dir");
            assert_eq!(write_env_file(Some(&"rel".into()), "u", &e).unwrap_err(), "runtime-dir-not-absolute");
            let _ = std::fs::remove_dir_all(&dir);
        }

        #[test]
        fn only_old_env_files_are_swept() {
            let dir = scratch("sweep");
            for name in ["scrybe-daemon-1-a.service.env", "other.env"] {
                std::fs::write(dir.join(name), "x").unwrap();
            }
            sweep_stale(&dir, SystemTime::now());
            assert!(dir.join("scrybe-daemon-1-a.service.env").exists(), "a fresh one may be in use");
            sweep_stale(&dir, SystemTime::now() + Duration::from_secs(120));
            assert!(!dir.join("scrybe-daemon-1-a.service.env").exists() && dir.join("other.env").exists());
            let _ = std::fs::remove_dir_all(&dir);
        }

        #[test]
        fn a_cap_needs_a_user_bus_and_systemd_run() {
            let dir = scratch("path");
            assert_eq!(cap_plan(&env(&[("PATH", "/usr/bin")]), 4096).unwrap_err(), "no-user-bus");
            let bus = env(&[("PATH", dir.to_str().unwrap()), ("XDG_RUNTIME_DIR", "/run/user/1")]);
            assert_eq!(cap_plan(&bus, 4096).unwrap_err(), "systemd-run-not-found");
            std::fs::write(dir.join("systemd-run"), "").unwrap();
            assert_eq!(cap_plan(&bus, 4096).unwrap(), (dir.join("systemd-run"), 4096));
            assert_eq!(cap_plan(&bus, 0).unwrap_err(), "disabled-by-config");
            let _ = std::fs::remove_dir_all(&dir);
        }

        #[test]
        fn systemd_gets_a_share_of_the_wait_and_never_all_of_it() {
            assert_eq!(wrapper_timeout(Duration::from_secs(5)), Duration::from_millis(1500));
            assert_eq!(wrapper_timeout(Duration::from_millis(100)), Duration::from_millis(250));
            assert_eq!(wrapper_timeout(Duration::from_secs(600)), Duration::from_secs(10));
        }

        #[test]
        fn a_live_process_shows_its_names_and_a_missing_one_is_gone() {
            let ProcessNames::Names(own) = process_env_names(i64::from(std::process::id())) else { panic!("own environment must be readable") };
            assert!(own.contains("PATH") && own.iter().all(|n| !n.contains('=')));
            assert_eq!(process_env_names(4_194_304 + 12_345), ProcessNames::Gone);
        }
    }
}
