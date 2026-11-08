//! Runs git the way `src/util/git-exec.ts` does: no shell, no console window, None on any failure.
use std::path::Path;
use std::process::{Command, Stdio};

pub fn command(cwd: &Path) -> Command {
    let mut cmd = Command::new("git");
    cmd.current_dir(cwd).stdin(Stdio::null()).stderr(Stdio::null());
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        const CREATE_NO_WINDOW: u32 = 0x0800_0000;
        cmd.creation_flags(CREATE_NO_WINDOW);
    }
    cmd
}

/// Raw stdout as text. None on failure, or past `max_bytes`, as Node's `maxBuffer` would give.
pub fn output(cwd: &Path, args: &[&str], max_bytes: Option<usize>) -> Option<String> {
    let out = command(cwd).args(args).output().ok()?;
    if !out.status.success() || max_bytes.is_some_and(|m| out.stdout.len() > m) {
        return None;
    }
    Some(String::from_utf8_lossy(&out.stdout).into_owned())
}

/// Runs to the end, or is killed at the timeout. True only for a clean exit.
pub fn run_with_timeout(cwd: &Path, args: &[&str], timeout: std::time::Duration) -> bool {
    let Ok(mut child) = command(cwd).args(args).stdout(Stdio::null()).spawn() else { return false };
    let end = std::time::Instant::now() + timeout;
    loop {
        match child.try_wait() {
            Ok(Some(status)) => return status.success(),
            Ok(None) if std::time::Instant::now() < end => std::thread::sleep(std::time::Duration::from_millis(100)),
            _ => {
                let _ = child.kill();
                let _ = child.wait();
                return false;
            }
        }
    }
}

pub fn trimmed(cwd: &Path, args: &[&str]) -> Option<String> {
    output(cwd, args, None).map(|s| s.trim().to_string())
}
