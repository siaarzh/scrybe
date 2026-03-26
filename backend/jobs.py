import threading
import time
import uuid

from . import indexer
from .indexer import IndexCancelled

_jobs: dict[str, dict] = {}
_lock = threading.Lock()


def submit(project_id: str, mode: str = "full") -> str:
    """Submit a background indexing job. Returns an 8-char job_id."""
    job_id = uuid.uuid4().hex[:8]
    cancel_event = threading.Event()

    job: dict = {
        "job_id": job_id,
        "project_id": project_id,
        "mode": mode,
        "phase": "scanning",
        "status": "running",
        "files_scanned": 0,
        "chunks_indexed": 0,
        "started_at": time.time(),
        "finished_at": None,
        "error": None,
        "_cancel": cancel_event,
    }

    with _lock:
        _jobs[job_id] = job

    def _scan(n: int) -> None:
        with _lock:
            _jobs[job_id]["files_scanned"] = n

    def _progress(n: int) -> None:
        with _lock:
            _jobs[job_id]["phase"] = "embedding"
            _jobs[job_id]["chunks_indexed"] = n

    def _run() -> None:
        try:
            result = indexer.index_project(
                project_id, mode,
                scan_cb=_scan,
                progress_cb=_progress,
                cancel_event=cancel_event,
            )
            with _lock:
                _jobs[job_id]["status"] = "done"
                _jobs[job_id]["phase"] = "done"
                _jobs[job_id]["chunks_indexed"] = result["chunks_indexed"]
                _jobs[job_id]["files_scanned"] = result["files_scanned"]
                _jobs[job_id]["finished_at"] = time.time()
        except IndexCancelled:
            with _lock:
                _jobs[job_id]["status"] = "cancelled"
                _jobs[job_id]["phase"] = "cancelled"
                _jobs[job_id]["finished_at"] = time.time()
        except Exception as exc:
            with _lock:
                _jobs[job_id]["status"] = "failed"
                _jobs[job_id]["phase"] = "failed"
                _jobs[job_id]["error"] = str(exc)
                _jobs[job_id]["finished_at"] = time.time()

    thread = threading.Thread(
        target=_run, daemon=True, name=f"scrybe-index-{job_id}"
    )
    thread.start()
    return job_id


def cancel(job_id: str) -> dict:
    """Signal a running job to stop. Returns immediately; stops at next checkpoint."""
    with _lock:
        job = _jobs.get(job_id)
        if job is None:
            return {"error": f"Job '{job_id}' not found."}
        if job["status"] != "running":
            return {
                "error": (
                    f"Job '{job_id}' is not running "
                    f"(status: {job['status']})."
                )
            }
        job["_cancel"].set()
    return {"job_id": job_id, "status": "cancelling"}


def get_status(job_id: str) -> dict | None:
    """Return a copy of the job dict (without internal fields), or None."""
    with _lock:
        job = _jobs.get(job_id)
        if job is None:
            return None
        return {k: v for k, v in job.items() if not k.startswith("_")}
