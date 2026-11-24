//! scrybe-rs: an unfinished Rust port of scrybe. Search over existing scrybe data.
mod autogc;
mod vecindex;
mod branches;
mod chunk;
mod cli;
mod collate;
mod config;
mod daemon_log;
mod embed;
mod embed_api;
mod ephemeral;
mod git;
mod github_issues;
mod gitlab_issues;
mod http;
mod index;
mod index_ticket;
mod jobs;
mod jsstr;
mod legacy;
mod lifecycle;
mod locks;
mod manage;
mod mcp;
mod mcp_http;
mod model;
mod ops;
mod phase;
mod pinned;
mod presets;
mod registry;
mod reindex;
mod rerank;
mod scan;
mod search;
mod serve;
mod source_add;
mod span;
mod spawn;
mod status;
mod store;
mod ticket_poll;
mod tools;
mod usage;
mod watch;

use clap::{CommandFactory, FromArgMatches, Parser, Subcommand};
use store::Store;

#[cfg(feature = "mimalloc")]
#[global_allocator]
static GLOBAL: mimalloc::MiMalloc = mimalloc::MiMalloc;

#[derive(Parser)]
#[command(name = "scrybe", bin_name = "scrybe", version = config::VERSION)]
struct Cli {
    /// With none, scrybe offers to register the repository it is run in.
    #[command(subcommand)]
    command: Option<Command>,
}

#[derive(Subcommand)]
enum Command {
    /// Serve the read tools to many clients over HTTP on loopback (scratch data dirs only)
    Serve,
    /// Search code or knowledge
    Search(SearchArgs),
    /// [deprecated] Use: scrybe branch pin/unpin/list
    #[command(hide = true)]
    Pin {
        #[command(subcommand)]
        action: legacy::PinAction,
    },
    /// Print shell completion script
    Completion {
        /// Shell type: bash | zsh | powershell
        shell: String,
    },
    /// Manage registered projects
    Project {
        #[command(subcommand)]
        action: cli::ProjectAction,
    },
    /// Manage indexable sources within a project
    Source {
        #[command(subcommand)]
        action: cli::SourceAction,
    },
    /// Manage background reindex jobs
    Job {
        #[command(subcommand)]
        action: cli::JobAction,
    },
    /// Manage indexed branches and pinned branches
    Branch {
        #[command(subcommand)]
        action: cli::BranchAction,
    },
    /// List all registered projects (shorthand for project list)
    Projects,
    /// List all sources (shorthand for source list)
    Sources(cli::SourcesArgs),
    /// List background reindex jobs (shorthand for job list)
    Jobs(cli::JobsArgs),
    /// List indexed branches (shorthand for branch list)
    Branches(cli::BranchListArgs),
    /// Index an open MR's remote branch under a throwaway '_ephemeral/' label
    IndexEphemeral(cli::IndexEphemeralArgs),
    /// Remove an '_ephemeral/' label created by index-ephemeral
    DropEphemeral(cli::DropEphemeralArgs),
    /// Remove orphan chunks not referenced by any indexed branch
    Gc(ops::GcArgs),
    /// Edit per-source private ignore rules
    Ignore {
        #[command(subcommand)]
        action: Option<ops::IgnoreAction>,
    },
    /// Show scrybe health (daemon + all projects)
    #[command(visible_alias = "ps")]
    Status(status::StatusArgs),
    /// Manage the background scrybe daemon
    Daemon {
        #[command(subcommand)]
        action: ops::DaemonAction,
    },
    /// Exact-symbol lookup
    Lookup {
        symbol: String,
        #[arg(short = 'P', long = "project-id")]
        project_id: String,
        #[arg(long)]
        exact: bool,
        #[arg(long, default_value_t = 50)]
        limit: usize,
    },
    /// Print token ids for a JSON list of texts in a file (parity checks)
    DebugTokens { file: String, #[arg(long, default_value = "Xenova/multilingual-e5-small")] model: String },
    /// Index or reindex a project (all sources) or specific sources
    Index(reindex::IndexArgs),
    /// Chunk every file of a code source and print one line per chunk (parity checks)
    DebugChunks { #[arg(short = 'P', long = "project-id")] project_id: String, #[arg(short = 'S', long = "source-id")] source_id: String },
    /// Manage embedding model presets and assignments
    Model {
        #[command(subcommand)]
        action: model::ModelAction,
    },
    #[command(flatten)]
    Old(legacy::OldCommand),
    /// Try a keyword search on every registered table and report which fail (read-only)
    DebugFts,
    /// Time a download with the model client: into memory, or to a file with --to
    DebugFetch { url: String, #[arg(long)] to: Option<String> },
    /// Load the local model step by step and print resident memory after each step
    DebugLoadMem { #[arg(long, default_value = "Xenova/multilingual-e5-small")] model: String },
    /// Print a query's vector and keyword lists before fusion, as JSON (parity checks)
    DebugLists { query: String, #[arg(short = 'P', long = "project-id")] project_id: String, #[arg(long = "top-k", default_value_t = 10)] top_k: usize },
    /// Score `{"query", "passages"}` from a JSON file with the local reranker; prints token ids and scores (parity checks)
    DebugRerank { file: String, #[arg(long, default_value = rerank::DEFAULT_LOCAL_MODEL)] model: String },
    /// Print a query's embedding as JSON (parity checks)
    Embed { text: String, #[arg(long, default_value = "Xenova/multilingual-e5-small")] model: String, #[arg(long, default_value = "query: ")] prefix: String },
}

/// `search code`, `search knowledge`, or the deprecated bare `search <query...>`.
#[derive(clap::Args)]
#[command(args_conflicts_with_subcommands = true)]
struct SearchArgs {
    #[command(subcommand)]
    kind: Option<SearchKind>,
    /// Deprecated: use `search code <query>`
    query: Vec<String>,
    /// Project ID (deprecated bare form)
    #[arg(long = "project-id", value_name = "id")]
    project_id: Option<String>,
    /// Number of results (deprecated bare form)
    #[arg(long = "top-k", value_name = "n", default_value = "10")]
    top_k: String,
    /// Branch to search (deprecated bare form)
    #[arg(long, value_name = "name")]
    branch: Option<String>,
}

#[derive(Subcommand)]
enum SearchKind {
    Code {
        query: String,
        #[arg(short = 'P', long = "project-id", value_name = "id")]
        project_id: String,
        // Accepted and ignored, as today's build does: the parent `search --top-k` takes the value.
        #[arg(long = "top-k", value_name = "n", default_value = "10")]
        _top_k: String,
        #[arg(long, value_name = "name")]
        branch: Option<String>,
    },
    Knowledge {
        query: String,
        #[arg(short = 'P', long = "project-id", value_name = "id")]
        project_id: String,
        #[arg(short = 'S', long = "source-id", value_name = "id")]
        source_id: Option<String>,
        #[arg(long = "item-types", value_name = "types")]
        item_types: Option<String>,
        // Accepted and ignored, as `search code`'s is.
        #[arg(long = "top-k", value_name = "n", default_value = "10")]
        _top_k: String,
    },
}

/// What `search code` and `search knowledge` return from the command line whatever `--top-k` says.
const CLI_SEARCH_TOP_K: usize = 10;

/// What `search code` and `search knowledge` print on failure: `[scrybe] <message>`.
fn search_fail(e: tools::ToolError) -> ! {
    eprintln!("[scrybe] {}", e.message);
    std::process::exit(1)
}

fn fail(e: tools::ToolError) -> ! {
    eprintln!("{}", serde_json::to_string_pretty(&e.to_json()).unwrap_or(e.message));
    std::process::exit(1)
}

fn main() -> anyhow::Result<()> {
    config::load_env_file();
    let args: Vec<String> = std::env::args_os().skip(1).map(|a| a.to_string_lossy().into_owned()).collect();
    let mcp = args.first().is_some_and(|a| a == "mcp");
    if mcp && !args.iter().any(|a| a == "--legacy-in-process") {
        let exe = std::env::current_exe().map_or_else(|_| "scrybe".to_string(), |p| p.to_string_lossy().into_owned());
        scrybe_relay::run(vec![exe, "daemon".into(), "up".into()]);
    }
    if let Err(message) = chunk::Sizes::from_env().check() {
        eprintln!("scrybe error: Error: {message}");
        std::process::exit(1);
    }
    if !mcp {
        ops::warn_version_skew(args.iter().any(|a| a == "--json"));
    }
    let cli = if mcp { None } else { Some(parse(&args)) };
    // Deep ASTs recurse: chunking runs on blocking threads with room for them.
    let rt = tokio::runtime::Builder::new_multi_thread().worker_threads(2).thread_stack_size(64 << 20).enable_all().build()?;
    // The command future is big and Windows gives the main thread 1 MB, so it runs boxed on a thread with room.
    let main_task = std::thread::Builder::new().stack_size(64 << 20).spawn(move || rt.block_on(Box::pin(run(cli))))?;
    main_task.join().unwrap_or_else(|panic| std::panic::resume_unwind(panic))
}

/// The command line with the last of a repeated option winning, and its own help and descriptions.
pub(crate) fn command() -> clap::Command {
    usage::dress(Cli::command(), usage::Spec::load().as_ref())
}

/// A usage error exits 1; help and version exit 0.
fn parse(args: &[String]) -> Cli {
    if let Some(spec) = usage::Spec::load() {
        match usage::check(&spec, args, &|name| Cli::command().find_subcommand(name).is_some()) {
            usage::Verdict::Run => {}
            usage::Verdict::Version => {
                println!("{}", config::VERSION);
                std::process::exit(0)
            }
            usage::Verdict::Refuse(text) => {
                eprintln!("{text}");
                std::process::exit(1)
            }
        }
    }
    command().try_get_matches().and_then(|m| Cli::from_arg_matches(&m)).unwrap_or_else(|e| {
        let code = i32::from(e.use_stderr());
        let _ = e.print();
        std::process::exit(code)
    })
}

/// Ctrl-C and SIGTERM end a command at once with exit code 0, whatever it was doing.
pub(crate) fn leave_on_signal() {
    tokio::spawn(async {
        #[cfg(unix)]
        {
            use tokio::signal::unix::{signal, SignalKind};
            let Ok(mut term) = signal(SignalKind::terminate()) else { return };
            tokio::select! {
                _ = term.recv() => {}
                _ = tokio::signal::ctrl_c() => {}
            }
            // SAFETY: skips exit handlers, which would race the threads still at work.
            unsafe { libc::_exit(0) }
        }
        #[cfg(not(unix))]
        if tokio::signal::ctrl_c().await.is_ok() {
            std::process::exit(0)
        }
    });
}

async fn run(cli: Option<Cli>) -> anyhow::Result<()> {
    let store = Store::new(config::Settings::from_env());
    let Some(cli) = cli else {
        eprintln!("[scrybe] in-process MCP mode is deprecated, will be removed in v0.34.0. See `scrybe daemon install`.");
        leave_on_signal();
        return mcp::serve(&store).await;
    };
    // A server, and an index run that follows one, see to signals themselves.
    if !matches!(cli.command, Some(Command::Serve | Command::Daemon { .. } | Command::Index(_))) {
        leave_on_signal();
    }
    let Some(command) = cli.command else {
        legacy::default_action(store).await;
        return Ok(());
    };
    match command {
        Command::Serve => serve::serve(store).await?,
        Command::Project { action } => cli::project(store, action).await,
        Command::Source { action } => cli::source(store, action).await,
        Command::Job { action } => cli::job(store, action),
        Command::Branch { action } => cli::branch(store, action),
        Command::Projects => cli::projects(),
        Command::Sources(args) => cli::sources(args),
        Command::Jobs(args) => cli::jobs(store, args),
        Command::Branches(args) => cli::branches(store, args),
        Command::IndexEphemeral(args) => cli::index_ephemeral(args).await,
        Command::DropEphemeral(args) => cli::drop_ephemeral(store, args).await,
        Command::Gc(args) => ops::gc(store, args).await,
        Command::Status(args) => status::status(store, args).await,
        Command::Ignore { action } => ops::ignore(action),
        Command::Daemon { action } => ops::daemon(store, action).await,
        Command::Search(SearchArgs { kind: Some(SearchKind::Code { query, project_id, branch, .. }), .. }) => {
            let hits = tools::search_code(&store, &project_id, &query, CLI_SEARCH_TOP_K, branch.as_deref()).await.unwrap_or_else(|e| search_fail(e));
            println!("{}", tools::format_code(&hits));
        }
        Command::Search(SearchArgs { kind: Some(SearchKind::Knowledge { query, project_id, source_id, item_types, .. }), .. }) => {
            let types: Option<Vec<String>> = item_types.map(|t| t.split(',').map(|s| s.trim().to_string()).collect());
            let hits = tools::search_knowledge(&store, &project_id, &query, CLI_SEARCH_TOP_K, source_id.as_deref(), types.as_deref()).await.unwrap_or_else(|e| search_fail(e));
            println!("{}", tools::format_knowledge(&hits));
        }
        Command::Search(SearchArgs { kind: None, query, project_id, top_k, branch }) => legacy::bare_search(&store, query, project_id, &top_k, branch).await,
        Command::Pin { action } => legacy::pin(action),
        Command::Completion { shell } => legacy::completion(&shell),
        Command::Lookup { symbol, project_id, exact, limit } => {
            let input = tools::LookupInput { project_id: &project_id, symbol_name: &symbol, exact, branch: None, source_id: None, case_sensitive: true, limit };
            let hits = tools::lookup_symbol(&store, input).await.unwrap_or_else(|e| fail(e));
            println!("{}", serde_json::to_string_pretty(&hits)?);
        }
        Command::DebugTokens { file, model } => {
            let texts: Vec<String> = serde_json::from_str(&std::fs::read_to_string(file)?)?;
            let ids: Vec<Vec<u32>> = texts.iter().map(|t| embed::tokens(&model, t)).collect::<anyhow::Result<_>>()?;
            println!("{}", serde_json::to_string(&ids)?);
        }
        Command::Index(args) => reindex::index(store, args).await,
        Command::Model { action } => Box::pin(model::model(store, action)).await,
        Command::Old(old) => Box::pin(legacy::old(store, old)).await,
        Command::DebugChunks { project_id, source_id } => {
            let handle = std::thread::Builder::new().stack_size(256 << 20).spawn(move || debug_chunks(&project_id, &source_id))?;
            handle.join().map_err(|_| anyhow::anyhow!("chunker thread panicked"))??;
        }
        Command::DebugFetch { url, to } => {
            let started = std::time::Instant::now();
            let bytes = embed::debug_fetch(&url, to.as_deref().map(std::path::Path::new)).await?;
            let secs = started.elapsed().as_secs_f64();
            println!("{bytes} bytes in {secs:.2} s, {:.1} MB/s", bytes as f64 / secs / 1e6);
        }
        Command::DebugLoadMem { model } => embed::debug_load_mem(&model)?,
        Command::DebugFts => {
            for p in registry::list_projects() {
                for s in &p.sources {
                    let Some(table) = &s.table_name else { continue };
                    let verdict = match store.fts_search(table, "search", &format!("project_id = '{}'", store::escape_sql(&p.id)), 1).await {
                        Ok(_) => "ok".to_string(),
                        Err(e) => format!("FAILS: {}", format!("{e:#}").chars().take(160).collect::<String>()),
                    };
                    println!("{} {} {table} {verdict}", p.id, s.source_id);
                }
            }
        }
        Command::DebugLists { query, project_id, top_k } => {
            println!("{}", serde_json::to_string(&search::debug_lists(&store, &query, &project_id, top_k).await?)?);
        }
        Command::DebugRerank { file, model } => {
            let input: serde_json::Value = serde_json::from_str(&std::fs::read_to_string(file)?)?;
            let query = input["query"].as_str().unwrap_or_default();
            let passages: Vec<String> = serde_json::from_value(input["passages"].clone())?;
            let ce = rerank::CrossEncoder::load_from(&embed::models_dir().join(&model))?;
            let ids: Vec<Vec<u32>> = passages.iter().map(|p| ce.encode_pair(query, p).map(|e| e.0)).collect::<anyhow::Result<_>>()?;
            println!("{}", serde_json::json!({ "ids": ids, "scores": ce.score(query, &passages)? }));
        }
        Command::Embed { text, model, prefix } => {
            println!("{}", serde_json::to_string(&embed::embed_query(&model, &prefix, &text).await?)?);
        }
    }
    Ok(())
}

fn debug_chunks(project_id: &str, source_id: &str) -> anyhow::Result<()> {
    use std::io::Write;
    let project = registry::get_project(project_id).ok_or_else(|| anyhow::anyhow!("no project"))?;
    let source = project.sources.iter().find(|s| s.source_id == source_id).ok_or_else(|| anyhow::anyhow!("no source"))?;
    let root = std::path::PathBuf::from(source.root_path().ok_or_else(|| anyhow::anyhow!("not a code source"))?);
    let sizes = chunk::Sizes::from_env();
    let max = Some(registry::resolve_embedding(source)?.char_cap());
    let mut out = std::io::BufWriter::new(std::io::stdout());
    for (rel, abs) in scan::walk_repo_files(&root, Some(project_id), Some(source_id)) {
        let Ok(bytes) = std::fs::read(&abs) else { continue };
        let text = jsstr::normalize_content(&String::from_utf8_lossy(&bytes));
        let lang = scan::language_of(&rel).unwrap_or("");
        writeln!(out, "F\t{rel}")?;
        for c in chunk::chunk_file(project_id, source_id, &rel, &text, lang, max, sizes) {
            writeln!(out, "{}\t{}\t{}\t{}\t{}\t{}", c.item_path, c.start_line, c.end_line, c.language, c.symbol_name, c.chunk_id)?;
        }
    }
    Ok(())
}
