//! The deprecated forms that still work: bare `search <query...>`, the `pin` group and the flat commands, plus `completion`.
//! Mirrors `src/cli.ts`, `src/cli-deprecation.ts` and `src/cli-completion.ts`.
use crate::cli::{self, clear_pinned, list_pinned, need, pin_branches, say, unpin_branches, ProjectAction, SourceAction};
use crate::store::Store;
use crate::{git, index, manage, registry};
use serde_json::json;
use std::io::{BufRead, Write};
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

/// The flat names commands had before they were grouped.
#[derive(Subcommand)]
pub enum OldCommand {
    /// [deprecated] Use: scrybe project add
    AddProject {
        #[arg(long, value_name = "id")]
        id: Option<String>,
        #[arg(long, value_name = "text", default_value = "")]
        desc: String,
    },
    /// [deprecated] Use: scrybe project update
    UpdateProject {
        #[arg(long, value_name = "id")]
        id: Option<String>,
        #[arg(long, value_name = "text")]
        desc: Option<String>,
    },
    /// [deprecated] Use: scrybe project remove
    RemoveProject {
        #[arg(long, value_name = "id")]
        id: Option<String>,
    },
    /// [deprecated] Use: scrybe project list
    ListProjects,
    /// [deprecated] Use: scrybe source add
    AddSource(cli::SourceAddArgs),
    /// [deprecated] Use: scrybe source update
    UpdateSource(cli::SourceUpdateArgs),
    /// [deprecated] Use: scrybe source remove
    RemoveSource {
        #[arg(long = "project-id", value_name = "id")]
        project_id: Option<String>,
        #[arg(long = "source-id", value_name = "id")]
        source_id: Option<String>,
    },
    /// [deprecated] Use: scrybe search knowledge
    SearchKnowledge {
        #[arg(long = "project-id", value_name = "id")]
        project_id: Option<String>,
        #[arg(long = "source-id", value_name = "id")]
        source_id: Option<String>,
        #[arg(long = "item-types", value_name = "types")]
        item_types: Option<String>,
        #[arg(long = "top-k", value_name = "n", default_value = "10")]
        top_k: String,
        query: String,
    },
}

const PROJECT_FLAG: &str = "--project-id <id>";
const SOURCE_FLAG: &str = "--source-id <id>";

/// `warnDeprecated`: yellow when stderr is a terminal, silenced by `SCRYBE_NO_DEPRECATION_WARNING=1`.
pub(crate) fn warn_deprecated(old: &str, new: &str) {
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

/// These have no error handler of their own, so a failure ends the run the way an uncaught one does.
pub async fn old(store: Store, command: OldCommand) {
    if let Err(e) = old_inner(store, command).await {
        eprintln!("scrybe error: Error: {e:#}");
        std::process::exit(1);
    }
}

async fn old_inner(store: Store, command: OldCommand) -> anyhow::Result<()> {
    match command {
        OldCommand::AddProject { id, desc } => {
            let id = need(id, "--id <id>");
            warn_deprecated("add-project", "project add");
            cli::project_inner(store, ProjectAction::Add { id: Some(id), desc: Some(desc) }).await
        }
        OldCommand::UpdateProject { id, desc } => {
            let id = need(id, "--id <id>");
            warn_deprecated("update-project", "project update");
            let mut a = json!({ "project_id": id });
            if let Some(desc) = desc {
                a["description"] = json!(desc);
            }
            let updated = manage::update_project(&a)?;
            say(&format!("Updated project '{}'", updated["id"].as_str().unwrap_or("")));
            Ok(())
        }
        OldCommand::RemoveProject { id } => {
            let id = need(id, "--id <id>");
            warn_deprecated("remove-project", "project remove");
            cli::remove_project(store, &id).await
        }
        OldCommand::ListProjects => {
            warn_deprecated("list-projects", "project list");
            cli::projects();
            Ok(())
        }
        OldCommand::AddSource(args) => {
            warn_deprecated("add-source", "source add");
            cli::source_inner(store, SourceAction::Add(args)).await
        }
        OldCommand::UpdateSource(args) => {
            warn_deprecated("update-source", "source update");
            cli::source_inner(store, SourceAction::Update(args)).await
        }
        OldCommand::RemoveSource { project_id, source_id } => {
            let (project_id, source_id) = (need(project_id, PROJECT_FLAG), need(source_id, SOURCE_FLAG));
            warn_deprecated("remove-source", "source remove");
            cli::source_inner(store, SourceAction::Remove { project_id: Some(project_id), source_id: Some(source_id) }).await
        }
        OldCommand::SearchKnowledge { project_id, source_id, item_types, top_k, query } => {
            let project_id = need(project_id, PROJECT_FLAG);
            warn_deprecated("search-knowledge", "search knowledge");
            let types: Option<Vec<String>> = item_types.filter(|t| !t.is_empty()).map(|t| t.split(',').map(|s| s.trim().to_string()).collect());
            let hits = tools::search_knowledge(&store, &project_id, &query, parse_int(&top_k).unwrap_or(10), source_id.as_deref(), types.as_deref()).await.map_err(|e| anyhow::anyhow!(e.message))?;
            say(&tools::format_knowledge(&hits));
            Ok(())
        }
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
    if query.is_empty() {
        let mut cmd = crate::command();
        cmd.build();
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

/// The project id `scrybe` suggests for a folder: lower case, every other character a dash.
fn suggested_id(folder: &str) -> String {
    folder.to_lowercase().chars().map(|c| if c.is_ascii_lowercase() || c.is_ascii_digit() || c == '-' { c.to_string() } else { "-".repeat(c.len_utf16()) }).collect()
}

/// Bare `scrybe`: say how the repository here stands, and offer to register and index it when a person is at the terminal.
pub async fn default_action(store: Store) {
    let Ok(cwd) = std::env::current_dir() else {
        eprintln!("Not a git repository. Run `scrybe init` to set up scrybe.");
        std::process::exit(1);
    };
    if git::output(&cwd, &["rev-parse", "--git-dir"], None).is_none() {
        eprintln!("Not a git repository. Run `scrybe init` to set up scrybe.");
        std::process::exit(1);
    }
    let here = cwd.to_string_lossy().into_owned();
    if registry::list_projects().iter().any(|p| p.sources.iter().any(|s| s.kind() == "code" && s.root_path() == Some(here.as_str()))) {
        println!("Repo already registered in scrybe. Try:\n  scrybe index -P <id>\n  scrybe search code -P <id> \"your query\"\n  scrybe status");
        return;
    }
    if !std::io::stdin().is_terminal() {
        println!("Repo not yet registered. Run:\n  scrybe init          # full wizard (recommended)");
        return;
    }
    let id = suggested_id(&cwd.file_name().map(|n| n.to_string_lossy().into_owned()).unwrap_or_default());
    print!("Register '{id}' at {here} and run incremental index? [y/N] ");
    let _ = std::io::stdout().flush();
    let mut line = String::new();
    let _ = std::io::stdin().lock().read_line(&mut line);
    if crate::jsstr::js_trim(&line).to_lowercase() != "y" {
        println!("Aborted.");
        return;
    }
    let outcome: anyhow::Result<()> = async {
        registry::add_project(&id, "")?;
        registry::add_source(&id, json!({ "source_id": "primary", "source_config": { "type": "code", "root_path": here, "languages": [] } }))?;
        println!("Registered '{id}'. Indexing...");
        let options = index::Options::default();
        index::index_source(&store, &id, "primary", index::Mode::Incremental, &options).await?;
        println!("Done. Try: scrybe search code -P {id} \"your query\"");
        Ok(())
    }
    .await;
    if let Err(e) = outcome {
        eprintln!("scrybe error: Error: {e:#}");
        std::process::exit(1);
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
    fn a_folder_name_becomes_an_id() {
        assert_eq!(suggested_id("My Repo_2"), "my-repo-2");
        assert_eq!(suggested_id("ok-name"), "ok-name");
        assert_eq!(suggested_id("é😀"), "-" .to_string() + "--");
    }

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
