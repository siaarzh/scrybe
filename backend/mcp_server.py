"""
MCP server exposing scrybe tools to Claude Code.

Registered in ~/.claude.json under mcpServers:
  "scrybe": {
    "type": "stdio",
    "command": "/path/to/scrybe/.venv/Scripts/python.exe",
    "args": ["-m", "backend.mcp_server"],
    "env": {
      "PYTHONPATH": "/path/to/scrybe",
      "OPENAI_API_KEY": "sk-..."   // or omit and put it in .env at the repo root
    }
  }

Runtime data (projects, hashes, vector DB) lives in the OS user data directory:
  Windows: %LOCALAPPDATA%\\scrybe\\scrybe\\
  Linux:   ~/.local/share/scrybe/
  Mac:     ~/Library/Application Support/scrybe/
"""

from fastmcp import FastMCP

from . import embedder, jobs, registry, vector_store
from .config import settings

mcp = FastMCP("scrybe")

_NOT_FOUND = "' not found. Call list_projects() first."


@mcp.tool()
def list_projects() -> list[dict]:
    """List all registered projects with their IDs, root paths, and languages."""
    return [p.model_dump() for p in registry.list_projects()]


@mcp.tool()
def add_project(project_id: str, root_path: str, languages: list[str] = [], description: str = "") -> dict:
    """
    Register a new project. Errors if a project with that ID already exists — use update_project to modify it.
    languages: list of language tags, e.g. ['cs'] or ['ts', 'vue'].
    """
    from .models import Project
    try:
        project = Project(id=project_id, root_path=root_path, languages=languages, description=description)
        registry.add_project(project)
        return {"ok": True, "project_id": project_id, "root_path": root_path}
    except ValueError as e:
        return {"error": str(e)}


@mcp.tool()
def update_project(
    project_id: str,
    root_path: str | None = None,
    languages: list[str] | None = None,
    description: str | None = None,
) -> dict:
    """
    Update an existing project's root path, languages, or description.
    Only the fields you provide are changed. Errors if the project doesn't exist — use add_project to register it.
    """
    try:
        project = registry.update_project(project_id, root_path=root_path, languages=languages, description=description)
        return project.model_dump()
    except ValueError as e:
        return {"error": str(e)}


@mcp.tool()
def search_code(
    project_id: str, query: str, top_k: int = 10
) -> list[dict]:
    """
    Semantically search code in a project by natural language query.
    Returns relevant code snippets with file paths and line numbers.
    """
    project = registry.get_project(project_id)
    if project is None:
        return [{"error": f"Project '{project_id}{_NOT_FOUND}"}]
    vector_store.ensure_collection()
    query_vector = embedder.embed_texts([query])[0]
    results = vector_store.search(query_vector, project_id, top_k)
    return [r.model_dump() for r in results]


@mcp.tool()
def reindex_project(project_id: str, mode: str = "full") -> dict:
    """
    Trigger re-indexing of a project in the background.
    Returns immediately with a job_id. Poll progress with reindex_status(job_id).

    mode='incremental' (default recommendation):
      - Scans all files, compares SHA256 hashes against stored state
      - Only re-embeds files that changed, were added, or were deleted
      - Use after: git pull, branch switch, or any code change
      - Caveat: if hash state is missing (e.g. first run, data dir wiped), treats all
        files as new and re-embeds everything WITHOUT clearing first — use 'full' instead

    mode='full':
      - Clears ALL existing vectors for this project from Qdrant, then rebuilds
      - Use when: first index, hash file lost/corrupted, or index seems stale/wrong
      - Slower and costs more API tokens, but always produces a clean state
    """
    project = registry.get_project(project_id)
    if project is None:
        return {"error": f"Project '{project_id}{_NOT_FOUND}"}
    job_id = jobs.submit(project_id, mode)
    return {
        "job_id": job_id,
        "status": "started",
        "project_id": project_id,
        "mode": mode,
    }


@mcp.tool()
def reindex_status(job_id: str) -> dict:
    """
    Get the status of a background reindex job.
    Returns phase ('scanning'|'embedding'|'done'|'cancelled'|'failed'),
    files_scanned, chunks_indexed, and error if any.
    Note: jobs are lost if the MCP server restarts.
    """
    status = jobs.get_status(job_id)
    if status is None:
        return {
            "error": (
                f"Job '{job_id}' not found. "
                "Jobs are lost on server restart."
            )
        }
    return status


@mcp.tool()
def cancel_reindex(job_id: str) -> dict:
    """
    Cancel a running reindex job. Stops at the next batch checkpoint.
    Has no effect if the job is already done or failed.
    """
    return jobs.cancel(job_id)


if __name__ == "__main__":
    mcp.run()
