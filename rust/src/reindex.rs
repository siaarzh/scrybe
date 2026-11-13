//! The `index` command. Mirrors `index` and `runIndexViaDaemon` in `src/cli.ts`.
use crate::cli::{post, server_state, Server};
use crate::index::{self, Mode, Options};
use crate::ops::client;
use crate::store::Store;
use crate::registry;
use anyhow::Result;
use clap::Args;
use serde_json::{json, Value};
use std::io::Write;
use std::time::{Duration, Instant};

#[derive(Args)]
pub struct IndexArgs {
    /// Project ID (omit when using --all)
    #[arg(short = 'P', long = "project-id", value_name = "id")]
    project_id: Option<String>,
    /// Comma-separated source IDs (e.g. primary,gitlab-issues)
    #[arg(short = 'S', long = "source-ids", alias = "source-id", value_name = "ids")]
    source_ids: Option<String>,
    /// Incrementally reindex all registered projects
    #[arg(short = 'a', long)]
    all: bool,
    /// Full reindex (clears and rebuilds from scratch)
    #[arg(short = 'f', long)]
    full: bool,
    /// Incremental reindex (default)
    #[arg(short = 'I', long)]
    incremental: bool,
    /// Branch name to index (default: current HEAD for code sources)
    #[arg(long, value_name = "name")]
    branch: Option<String>,
    /// Git ref to read content from, such as origin/dev; --branch stays the stored label
    #[arg(long = "content-ref", value_name = "ref")]
    content_ref: Option<String>,
    /// Submit to the server and return at once, printing the job id
    #[arg(long)]
    detach: bool,
}

/// `formatIndexResult`.
fn format_result(chunks: u64, reindexed: u64, removed: u64) -> String {
    if removed > 0 && chunks == 0 && reindexed == 0 {
        return format!("{removed} file(s) removed from index. Run 'scrybe gc' to reclaim disk space.");
    }
    format!("{chunks} chunks indexed, {reindexed} files reindexed, {removed} files removed")
}

fn counts(r: &Value) -> (u64, u64, u64) {
    let n = |k: &str| r[k].as_u64().unwrap_or(0);
    (n("chunks_prepared"), n("files_reindexed"), n("files_removed"))
}

fn given(v: &Option<String>) -> Option<String> {
    v.clone().filter(|s| !s.is_empty())
}

fn options(a: &IndexArgs) -> Options {
    Options { branch: given(&a.branch), content_ref: given(&a.content_ref), cancel: None, job_id: None }
}

/// The server's job, followed like `runIndexViaDaemon` does: one progress line rewritten each second.
async fn via_server(port: u16, a: &IndexArgs, project: &str, source: Option<&str>, mode: &str) -> Result<i32> {
    let mut body = serde_json::Map::new();
    body.insert("projectId".into(), json!(project));
    if let Some(s) = source {
        body.insert("sourceId".into(), json!(s));
    }
    if let Some(b) = given(&a.branch) {
        body.insert("branch".into(), json!(b));
    }
    body.insert("mode".into(), json!(mode));
    if let Some(c) = given(&a.content_ref) {
        body.insert("contentRef".into(), json!(c));
    }
    let sent = post(port, "/kick", &Value::Object(body)).await?;
    let Some(job) = sent["jobs"].get(0).filter(|j| j.is_object()) else { anyhow::bail!("Daemon returned no job") };
    let id = job["jobId"].as_str().unwrap_or("").to_string();
    let position = job["queuePosition"].as_i64();
    if a.detach {
        let at = position.map_or(String::new(), |p| format!(" (queue position: {p})"));
        println!("Job {}: {id}{at}", job["status"].as_str().unwrap_or("queued"));
        return Ok(0);
    }
    let target = source.unwrap_or("(all sources)");
    match position {
        Some(p) if p > 0 => println!("Queued {project}/{target} at position {p} (job_id: {id})"),
        _ => println!("Indexing {project}/{target} ({mode})... (job_id: {id})"),
    }
    let http = client(Duration::from_secs(5))?;
    let (start, frames) = (Instant::now(), ["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"]);
    let mut spin = 0;
    loop {
        let interrupted = tokio::select! {
            () = tokio::time::sleep(Duration::from_secs(1)) => false,
            _ = tokio::signal::ctrl_c() => true,
        };
        if interrupted {
            println!();
            let _ = http.delete(format!("http://127.0.0.1:{port}/jobs/{id}")).send().await;
            println!("Cancelling...");
            return Ok(0);
        }
        let row = match http.get(format!("http://127.0.0.1:{port}/jobs/{id}")).send().await {
            Ok(r) if r.status().is_success() => r.json::<Value>().await.ok(),
            _ => None,
        };
        let phase = row.as_ref().and_then(|r| r["phase"].as_str()).filter(|p| !p.is_empty()).unwrap_or("waiting");
        print!("\r  {} {phase}... {:.0}s  ", frames[spin % frames.len()], start.elapsed().as_secs_f64());
        let _ = std::io::stdout().flush();
        spin += 1;
        let Some(row) = row else { continue };
        match row["status"].as_str().unwrap_or("") {
            "done" => {
                println!("\nDone.");
                return Ok(0);
            }
            "failed" => {
                println!();
                eprintln!("Failed: {}", row["error_message"].as_str().unwrap_or("unknown error"));
                return Ok(1);
            }
            "cancelled" => {
                println!("\nCancelled.");
                return Ok(0);
            }
            _ => {}
        }
    }
}

async fn all_projects(store: &Store, a: &IndexArgs) -> Result<i32> {
    if given(&a.project_id).is_some() {
        eprintln!("Warning: --project-id is ignored when --all is specified");
    }
    if given(&a.source_ids).is_some() {
        eprintln!("Warning: --source-ids is ignored when --all is specified");
    }
    let projects = registry::list_projects();
    if projects.is_empty() {
        println!("No projects registered.");
        return Ok(0);
    }
    println!("Incrementally reindexing all {} project(s)...", projects.len());
    let mut failed = 0;
    for p in &projects {
        println!("\n── {} ({} source(s))", p.id, p.sources.len());
        let mut totals = (0, 0, 0);
        let mut error = None;
        for s in &p.sources {
            match index::index_source(store, &p.id, &s.source_id, Mode::Incremental, &Options { branch: None, content_ref: None, cancel: None, job_id: None }).await {
                Ok(r) => {
                    let (c, i, d) = counts(&r);
                    totals = (totals.0 + c, totals.1 + i, totals.2 + d);
                }
                Err(e) => {
                    error = Some(e);
                    break;
                }
            }
        }
        match error {
            None => println!("\n  Done ({} source(s)): {}", p.sources.len(), format_result(totals.0, totals.1, totals.2)),
            Some(e) => {
                eprintln!("\n  Failed: {e:#}");
                failed += 1;
            }
        }
    }
    println!("\nAll projects processed. {}", if failed > 0 { format!("{failed} failed.") } else { "All succeeded.".to_string() });
    Ok(i32::from(failed > 0))
}

const ZERO_CHUNKS: &str = "[scrybe] Warning: files were scheduled for reindex but 0 chunks were written. Run with --full or check embedding config.";

async fn in_process(store: &Store, a: &IndexArgs, project: &str, sources: &[String], mode: Mode, mode_word: &str) -> Result<i32> {
    let opts = options(a);
    if !sources.is_empty() {
        let target: Vec<String> = sources.iter().map(|s| format!("{project}/{s}")).collect();
        println!("Indexing {} ({mode_word})...", target.join(", "));
        let mut totals = (0, 0, 0);
        for sid in sources {
            let r = index::index_source(store, project, sid, mode, &Options { branch: opts.branch.clone(), content_ref: opts.content_ref.clone(), cancel: None, job_id: None }).await?;
            let (c, i, d) = counts(&r);
            println!("\n  [{sid}] Done: {}", format_result(c, i, d));
            totals = (totals.0 + c, totals.1 + i, totals.2 + d);
        }
        if sources.len() > 1 {
            println!("\nTotal: {} chunks indexed, {} files reindexed, {} files removed", totals.0, totals.1, totals.2);
        }
        if totals.1 > 0 && totals.0 == 0 {
            eprintln!("{ZERO_CHUNKS}");
            return Ok(2);
        }
        return Ok(0);
    }
    println!("Indexing '{project}' (all sources) ({mode_word})...");
    let found = registry::get_project(project).ok_or_else(|| anyhow::anyhow!("Project '{project}' not found"))?;
    let mut totals = (0, 0, 0);
    for s in &found.sources {
        let r = index::index_source(store, project, &s.source_id, mode, &Options { branch: opts.branch.clone(), content_ref: opts.content_ref.clone(), cancel: None, job_id: None }).await?;
        let (c, i, d) = counts(&r);
        totals = (totals.0 + c, totals.1 + i, totals.2 + d);
    }
    println!("\nDone ({} source(s)): {}", found.sources.len(), format_result(totals.0, totals.1, totals.2));
    if totals.1 > 0 && totals.0 == 0 {
        eprintln!("{ZERO_CHUNKS}");
        return Ok(2);
    }
    Ok(0)
}

async fn run(store: Store, a: IndexArgs) -> Result<i32> {
    if let Err(e) = index::refuse_live_data_dir() {
        eprintln!("[scrybe] {e:#}");
        return Ok(1);
    }
    let status = registry::embedding_status();
    if status["config_error"] == true {
        eprintln!("[scrybe] {}", status["config_error_message"].as_str().unwrap_or("embedding config error"));
        return Ok(1);
    }
    if a.all {
        return all_projects(&store, &a).await;
    }
    let Some(project) = given(&a.project_id) else {
        eprintln!("--project-id is required (or use --all to reindex everything)");
        return Ok(1);
    };
    let (mode, word) = if a.full { (Mode::Full, "full") } else { (Mode::Incremental, "incremental") };
    let sources: Vec<String> = a.source_ids.as_deref().unwrap_or("").split(',').map(|s| s.trim().to_string()).filter(|s| !s.is_empty()).collect();
    if a.full && sources.is_empty() {
        eprintln!("Error: --full requires --source-ids (e.g. --source-ids primary,gitlab-issues)");
        return Ok(1);
    }
    match server_state().await {
        Server::Up(port) => {
            return match via_server(port, &a, &project, if sources.len() == 1 { Some(sources[0].as_str()) } else { None }, word).await {
                Ok(code) => Ok(code),
                Err(e) => {
                    eprintln!("[scrybe] {e:#}");
                    Ok(1)
                }
            };
        }
        Server::Draining => {
            eprintln!("[scrybe] Error: the scrybe daemon is shutting down and is not accepting new jobs.\nRetry in a moment — a replacement daemon starts on the next call.");
            return Ok(1);
        }
        Server::Down => {}
    }
    in_process(&store, &a, &project, &sources, mode, word).await
}

pub async fn index(store: Store, args: IndexArgs) {
    let code = match run(store, args).await {
        Ok(code) => code,
        Err(e) => {
            eprintln!("scrybe error: Error: {e:#}");
            1
        }
    };
    if code != 0 {
        std::process::exit(code);
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_run_that_only_removed_files_says_so() {
        assert_eq!(format_result(0, 0, 3), "3 file(s) removed from index. Run 'scrybe gc' to reclaim disk space.");
        assert_eq!(format_result(5, 2, 1), "5 chunks indexed, 2 files reindexed, 1 files removed");
        assert_eq!(format_result(0, 0, 0), "0 chunks indexed, 0 files reindexed, 0 files removed");
    }
}
