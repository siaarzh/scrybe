import threading
from typing import Callable

from . import embedder, registry, vector_store
from . import hashes as hash_store
from .chunker import chunk_repo, walk_repo_files


class IndexCancelled(Exception):
    pass


def index_project(
    project_id: str,
    mode: str = "full",
    scan_cb: Callable[[int], None] | None = None,
    progress_cb: Callable[[int], None] | None = None,
    cancel_event: threading.Event | None = None,
) -> dict:
    project = registry.get_project(project_id)
    if project is None:
        raise ValueError(f"Project '{project_id}' not found in registry.")

    vector_store.ensure_collection()

    def _check_cancel() -> None:
        if cancel_event and cancel_event.is_set():
            raise IndexCancelled("Reindex cancelled by user.")

    # --- Pass 1: scan all files, compute hashes, find what changed ---
    current_hashes: dict[str, str] = {}
    files_scanned = 0
    for rel_path, abs_path in walk_repo_files(project.root_path):
        _check_cancel()
        current_hashes[rel_path] = hash_store.hash_file(abs_path)
        files_scanned += 1
        if scan_cb:
            scan_cb(files_scanned)

    if mode == "full":
        vector_store.delete_project(project_id)
        hash_store.delete_hashes(project_id)
        to_reindex = set(current_hashes.keys())
        files_removed = 0
    else:
        old_hashes = hash_store.load_hashes(project_id)
        to_remove = {p for p in old_hashes if p not in current_hashes}
        to_reindex = {
            p for p, h in current_hashes.items() if old_hashes.get(p) != h
        }
        for rel_path in to_remove | to_reindex:
            _check_cancel()
            vector_store.delete_file_chunks(project_id, rel_path)
        files_removed = len(to_remove)

    # --- Pass 2: chunk + embed only changed files (streaming, low memory) ---
    batch: list = []
    total = 0
    for chunk in chunk_repo(
        project_id, project.root_path, only_files=to_reindex
    ):
        _check_cancel()
        batch.append(chunk)
        if len(batch) == 100:
            vectors = embedder.embed_batched([c.content for c in batch])
            vector_store.upsert(batch, vectors)
            total += len(batch)
            print(f"  Indexed {total} chunks...", flush=True)
            if progress_cb:
                progress_cb(total)
            batch = []

    if batch:
        _check_cancel()
        vectors = embedder.embed_batched([c.content for c in batch])
        vector_store.upsert(batch, vectors)
        total += len(batch)
        if progress_cb:
            progress_cb(total)

    # Persist hashes after successful completion
    if mode == "full":
        hash_store.save_hashes(project_id, current_hashes)
    else:
        merged = {p: h for p, h in old_hashes.items() if p not in to_remove}
        merged.update(current_hashes)
        hash_store.save_hashes(project_id, merged)

    result: dict = {
        "status": "ok",
        "chunks_indexed": total,
        "project_id": project_id,
        "files_scanned": files_scanned,
        "files_reindexed": len(to_reindex),
    }
    if mode == "incremental":
        result["files_removed"] = files_removed
    return result
