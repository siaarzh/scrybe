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

pub fn trimmed(cwd: &Path, args: &[&str]) -> Option<String> {
    output(cwd, args, None).map(|s| s.trim().to_string())
}
