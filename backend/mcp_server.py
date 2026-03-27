"""
MCP server exposing scrybe tools to Claude Code.

Registered in ~/.claude.json under mcpServers:
  "scrybe": {
    "type": "stdio",
    "command": "/path/to/scrybe/.venv/Scripts/python.exe",
    "args": ["-m", "backend.mcp_server"],
    "env": { "PYTHONPATH": "/path/to/scrybe" }
  }

Requires Qdrant running at QDRANT_URL (default http://localhost:6333).
Start it once with: docker compose up -d
"""

import sys
import urllib.request

from fastmcp import FastMCP

from . import embedder, jobs, registry, vector_store
from .config import settings


def _check_qdrant() -> None:
    try:
        urllib.request.urlopen(f"{settings.qdrant_url}/healthz", timeout=3)
    except Exception:
        print(
            f"[scrybe] ERROR: Qdrant not reachable at {settings.qdrant_url}. "
            "Run 'docker compose up -d' in the scrybe directory.",
            file=sys.stderr,
        )
        sys.exit(1)


_check_qdrant()

mcp = FastMCP("scrybe")

_NOT_FOUND = "' not found. Call list_projects() first."


@mcp.tool()
def list_projects() -> list[dict]:
    """List all registered projects with their IDs, root paths, and languages."""
    return [p.model_dump() for p in registry.list_projects()]


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
      - Scans all files, compares SHA256 hashes against hashes/{project_id}.json
      - Only re-embeds files that changed, were added, or were deleted
      - Use after: git pull, branch switch, or any code change
      - Caveat: if hashes/{project_id}.json is missing, treats all files as new
        and re-embeds everything WITHOUT clearing Qdrant first — use 'full' instead

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
