import click
from backend import indexer, registry, vector_store, embedder
from backend.models import Project


@click.group()
def cli():
    """Scrybe — self-hosted code memory CLI."""


@cli.command("add-project")
@click.option("--id", "project_id", required=True, help="Unique project ID (e.g. cmx-ionic)")
@click.option("--root", required=True, help="Absolute path to the repo root")
@click.option("--languages", default="", help="Comma-separated language tags (e.g. ts,vue,py)")
@click.option("--desc", default="", help="Short description")
def add_project(project_id, root, languages, desc):
    """Register a project in the registry."""
    langs = [l.strip() for l in languages.split(",") if l.strip()]
    project = Project(id=project_id, root_path=root, languages=langs, description=desc)
    registry.add_project(project)
    click.echo(f"Added project '{project_id}' -> {root}")


@cli.command("list-projects")
def list_projects():
    """List all registered projects."""
    projects = registry.list_projects()
    if not projects:
        click.echo("No projects registered. Use 'add-project' to add one.")
        return
    for p in projects:
        langs = ", ".join(p.languages) if p.languages else "—"
        click.echo(f"  {p.id:30s}  {langs:20s}  {p.root_path}")


@cli.command("remove-project")
@click.option("--id", "project_id", required=True, help="Project ID to remove")
def remove_project(project_id):
    """Remove a project from the registry (does not delete indexed data)."""
    if registry.remove_project(project_id):
        click.echo(f"Removed project '{project_id}' from registry.")
    else:
        click.echo(f"Project '{project_id}' not found.", err=True)
        raise SystemExit(1)


@cli.command("status")
@click.option("--project-id", required=True, help="Project ID to check")
def status(project_id):
    """Show how many chunks are indexed for a project."""
    project = registry.get_project(project_id)
    if project is None:
        click.echo(f"Project '{project_id}' not found.", err=True)
        raise SystemExit(1)
    from qdrant_client.models import Filter, FieldCondition, MatchValue
    from backend.vector_store import _get_client
    from backend.config import settings
    vector_store.ensure_collection()
    client = _get_client()
    result = client.count(
        collection_name=settings.collection_name,
        count_filter=Filter(
            must=[FieldCondition(key="project_id", match=MatchValue(value=project_id))]
        ),
    )
    click.echo(f"Project '{project_id}': {result.count} chunks indexed")


@cli.command("index")
@click.option("--project-id", required=True, help="Project ID to index")
@click.option("--full", "mode", flag_value="full", default=True, help="Full re-index (default)")
@click.option("--incremental", "mode", flag_value="incremental", help="Incremental index")
def index(project_id, mode):
    """Index a project into the vector database."""
    click.echo(f"Indexing '{project_id}' (mode={mode})...")
    try:
        result = indexer.index_project(project_id, mode)
        msg = f"Done. Chunks indexed: {result['chunks_indexed']}"
        if mode == "incremental":
            msg += f"  (files changed: {result.get('files_reindexed', 0)}, deleted: {result.get('files_removed', 0)})"
        click.echo(msg)
    except ValueError as e:
        click.echo(f"Error: {e}", err=True)
        raise SystemExit(1)


@cli.command("search")
@click.option("--project-id", required=True, help="Project ID to search")
@click.option("--top-k", default=5, show_default=True, help="Number of results")
@click.argument("query")
def search(project_id, top_k, query):
    """Search code in a project by natural language query."""
    project = registry.get_project(project_id)
    if project is None:
        click.echo(f"Error: project '{project_id}' not found.", err=True)
        raise SystemExit(1)
    vector_store.ensure_collection()
    query_vector = embedder.embed_texts([query])[0]
    results = vector_store.search(query_vector, project_id, top_k)
    if not results:
        click.echo("No results found.")
        return
    for i, r in enumerate(results, 1):
        click.echo(f"\n[{i}] {r.file_path}:{r.start_line}-{r.end_line}  score={r.score:.3f}  ({r.language})")
        click.echo("-" * 60)
        # Print first 10 lines of content
        lines = r.content.splitlines()[:10]
        click.echo("\n".join(lines))
        if len(r.content.splitlines()) > 10:
            click.echo("  ...")


if __name__ == "__main__":
    cli()
