//! scrybe-rs: an unfinished Rust port of scrybe. Search over existing scrybe data.
mod autogc;
mod vecindex;
mod branches;
mod chunk;
mod cli;
mod collate;
mod config;
mod embed;
mod embed_api;
mod ephemeral;
mod git;
mod github_issues;
mod gitlab_issues;
mod index;
mod index_ticket;
mod jobs;
mod jsstr;
mod lifecycle;
mod manage;
mod mcp;
mod ops;
mod phase;
mod pinned;
mod presets;
mod registry;
mod reindex;
mod scan;
mod search;
mod serve;
mod source_add;
mod status;
mod store;
mod ticket_poll;
mod tools;
mod watch;

use clap::{Parser, Subcommand};
use store::Store;

#[cfg(feature = "mimalloc")]
#[global_allocator]
static GLOBAL: mimalloc::MiMalloc = mimalloc::MiMalloc;

#[derive(Parser)]
#[command(name = "scrybe-rs", version = config::VERSION, about = "Unfinished Rust port of scrybe")]
struct Cli {
    #[command(subcommand)]
    command: Command,
}

#[derive(Subcommand)]
enum Command {
    /// Serve the read tools over MCP stdio
    Mcp,
    /// Serve the read tools to many clients over HTTP on loopback (scratch data dirs only)
    Serve,
    /// Search code or knowledge
    Search {
        #[command(subcommand)]
        kind: SearchKind,
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
    #[command(alias = "ps")]
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
    /// Try a keyword search on every registered table and report which fail (read-only)
    DebugFts,
    /// Print a query's vector and keyword lists before fusion, as JSON (parity checks)
    DebugLists { query: String, #[arg(short = 'P', long = "project-id")] project_id: String, #[arg(long = "top-k", default_value_t = 10)] top_k: usize },
    /// Print a query's embedding as JSON (parity checks)
    Embed { text: String, #[arg(long, default_value = "Xenova/multilingual-e5-small")] model: String, #[arg(long, default_value = "query: ")] prefix: String },
}

#[derive(Subcommand)]
enum SearchKind {
    Code {
        query: String,
        #[arg(short = 'P', long = "project-id")]
        project_id: String,
        #[arg(long = "top-k", default_value_t = 10)]
        top_k: usize,
        #[arg(long)]
        branch: Option<String>,
    },
    Knowledge {
        query: String,
        #[arg(short = 'P', long = "project-id")]
        project_id: String,
        #[arg(short = 'S', long = "source-id")]
        source_id: Option<String>,
        #[arg(long = "item-types")]
        item_types: Option<String>,
        #[arg(long = "top-k", default_value_t = 10)]
        top_k: usize,
    },
}

fn fail(e: tools::ToolError) -> ! {
    eprintln!("{}", serde_json::to_string_pretty(&e.to_json()).unwrap_or(e.message));
    std::process::exit(1)
}

fn main() -> anyhow::Result<()> {
    config::load_env_file();
    // A usage error exits 1, like the TypeScript command line; help and version still exit 0.
    let cli = Cli::try_parse().unwrap_or_else(|e| {
        let code = i32::from(e.use_stderr());
        let _ = e.print();
        std::process::exit(code)
    });
    // Deep ASTs recurse: chunking runs on blocking threads with room for them.
    let rt = tokio::runtime::Builder::new_multi_thread().worker_threads(2).thread_stack_size(64 << 20).enable_all().build()?;
    // The command future is big and Windows gives the main thread 1 MB, so it runs boxed on a thread with room.
    let main_task = std::thread::Builder::new().stack_size(64 << 20).spawn(move || rt.block_on(Box::pin(run(cli))))?;
    main_task.join().unwrap_or_else(|panic| std::panic::resume_unwind(panic))
}

async fn run(cli: Cli) -> anyhow::Result<()> {
    let store = Store::new(config::Settings::from_env());
    match cli.command {
        Command::Mcp => mcp::serve(&store).await?,
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
        Command::Search { kind: SearchKind::Code { query, project_id, top_k, branch } } => {
            let hits = tools::search_code(&store, &project_id, &query, top_k, branch.as_deref()).await.unwrap_or_else(|e| fail(e));
            println!("{}", tools::format_code(&hits));
        }
        Command::Search { kind: SearchKind::Knowledge { query, project_id, source_id, item_types, top_k } } => {
            let types: Option<Vec<String>> = item_types.map(|t| t.split(',').map(|s| s.trim().to_string()).collect());
            let hits = tools::search_knowledge(&store, &project_id, &query, top_k, source_id.as_deref(), types.as_deref()).await.unwrap_or_else(|e| fail(e));
            println!("{}", tools::format_knowledge(&hits));
        }
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
        Command::DebugChunks { project_id, source_id } => {
            let handle = std::thread::Builder::new().stack_size(256 << 20).spawn(move || debug_chunks(&project_id, &source_id))?;
            handle.join().map_err(|_| anyhow::anyhow!("chunker thread panicked"))??;
        }
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
