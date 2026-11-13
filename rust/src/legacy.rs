//! The deprecated forms that still work: bare `search <query...>` and the `pin` group, plus `completion`.
//! Mirrors `src/cli.ts`, `src/cli-deprecation.ts` and `src/cli-completion.ts`.
use crate::cli::{clear_pinned, list_pinned, need, pin_branches, say, unpin_branches};
use crate::store::Store;
use crate::tools;
use clap::Subcommand;
use std::io::IsTerminal;

const BASH: &str = include_str!("completions/bash.txt");
const ZSH: &str = include_str!("completions/zsh.txt");
const POWERSHELL: &str = include_str!("completions/powershell.txt");

#[derive(Subcommand)]
pub enum PinAction {
    /// [deprecated] Use: scrybe branch list --pinned
    List {
        #[arg(long = "project-id", value_name = "id")]
        project_id: Option<String>,
        #[arg(long = "source-id", value_name = "id", default_value = "primary")]
        source_id: String,
    },
    /// [deprecated] Use: scrybe branch pin
    Add {
        #[arg(long = "project-id", value_name = "id")]
        project_id: Option<String>,
        #[arg(long = "source-id", value_name = "id", default_value = "primary")]
        source_id: String,
        branches: Vec<String>,
    },
    /// [deprecated] Use: scrybe branch unpin
    Remove {
        #[arg(long = "project-id", value_name = "id")]
        project_id: Option<String>,
        #[arg(long = "source-id", value_name = "id", default_value = "primary")]
        source_id: String,
        branches: Vec<String>,
    },
    /// [deprecated] Use: scrybe branch unpin --all
    Clear {
        #[arg(long = "project-id", value_name = "id")]
        project_id: Option<String>,
        #[arg(long = "source-id", value_name = "id", default_value = "primary")]
        source_id: String,
        #[arg(long)]
        yes: bool,
    },
}

const PROJECT_FLAG: &str = "--project-id <id>";

/// `warnDeprecated`: yellow when stderr is a terminal, silenced by `SCRYBE_NO_DEPRECATION_WARNING=1`.
fn warn_deprecated(old: &str, new: &str) {
    if std::env::var("SCRYBE_NO_DEPRECATION_WARNING").as_deref() == Ok("1") {
        return;
    }
    let msg = format!("[deprecated] '{old}' renamed to '{new}'; will be removed in v1.0");
    if std::io::stderr().is_terminal() {
        eprintln!("\x1b[33m{msg}\x1b[0m");
    } else {
        eprintln!("{msg}");
    }
}

fn need_branches(branches: &[String]) {
    if branches.is_empty() {
        eprintln!("error: missing required argument 'branches'");
        std::process::exit(1);
    }
}

/// The `pin` group has no error handler of its own, so a failure ends the run the way an uncaught one does.
pub fn pin(action: PinAction) {
    let result = match action {
        PinAction::List { project_id, source_id } => {
            let project_id = need(project_id, PROJECT_FLAG);
            warn_deprecated("pin list", "branch list --pinned");
            list_pinned(&project_id, Some(&source_id))
        }
        PinAction::Add { project_id, source_id, branches } => {
            let project_id = need(project_id, PROJECT_FLAG);
            need_branches(&branches);
            warn_deprecated("pin add", "branch pin");
            pin_branches(&project_id, &source_id, &branches)
        }
        PinAction::Remove { project_id, source_id, branches } => {
            let project_id = need(project_id, PROJECT_FLAG);
            need_branches(&branches);
            warn_deprecated("pin remove", "branch unpin");
            unpin_branches(&project_id, &source_id, &branches)
        }
        PinAction::Clear { project_id, source_id, yes } => {
            let project_id = need(project_id, PROJECT_FLAG);
            warn_deprecated("pin clear", "branch unpin --all");
            clear_pinned(&project_id, &source_id, yes)
        }
    };
    if let Err(e) = result {
        eprintln!("scrybe error: Error: {e:#}");
        std::process::exit(1);
    }
}

/// `parseInt(value, 10)` for the values a person types: the leading digits, or None.
fn parse_int(value: &str) -> Option<usize> {
    let v = value.trim_start();
    let digits: String = v.chars().take_while(char::is_ascii_digit).collect();
    digits.parse().ok()
}

/// `search <query...>` with no verb. With no words it shows the search help, like commander's `help()`.
pub async fn bare_search(store: &Store, query: Vec<String>, project_id: Option<String>, top_k: &str, branch: Option<String>) {
    use clap::CommandFactory;
    if query.is_empty() {
        let mut cmd = crate::Cli::command();
        if let Some(search) = cmd.find_subcommand_mut("search") {
            let _ = search.print_help();
        }
        std::process::exit(0);
    }
    let text = query.join(" ");
    let Some(project) = project_id.filter(|p| !p.is_empty()) else {
        eprintln!("[scrybe] Missing project ID. Try: scrybe search code -P <id> \"{text}\"  (run 'scrybe project list' to see ids)");
        std::process::exit(1);
    };
    warn_deprecated("search <query>", "search code <query>");
    let top_k = parse_int(top_k).unwrap_or(10);
    match tools::search_code(store, &project, &text, top_k, branch.as_deref().filter(|b| !b.is_empty())).await {
        Ok(hits) => say(&tools::format_code(&hits)),
        Err(e) => {
            eprintln!("[scrybe] {}", e.message);
            std::process::exit(1);
        }
    }
}

pub fn completion(shell: &str) {
    let script = match shell {
        "bash" => BASH,
        "zsh" => ZSH,
        "powershell" => POWERSHELL,
        other => {
            eprintln!("Unknown shell: {other}. Supported: bash, zsh, powershell");
            std::process::exit(1);
        }
    };
    print!("{script}");
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn the_numbers_people_type_read_like_parse_int() {
        assert_eq!(parse_int("10"), Some(10));
        assert_eq!(parse_int("5x"), Some(5));
        assert_eq!(parse_int("x5"), None);
    }

    #[test]
    fn the_completion_scripts_are_whole() {
        assert!(BASH.starts_with("# scrybe bash completion\n") && BASH.ends_with("complete -F _scrybe_completions scrybe\n"));
        assert!(ZSH.starts_with("#compdef scrybe\n") && ZSH.ends_with("_scrybe\n"));
        assert!(POWERSHELL.starts_with("Register-ArgumentCompleter") && POWERSHELL.ends_with("}\n"));
    }
}
