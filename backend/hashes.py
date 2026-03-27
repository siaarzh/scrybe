import hashlib
import json
from pathlib import Path

from .config import DATA_DIR

HASHES_DIR = DATA_DIR / "hashes"


def load_hashes(project_id: str) -> dict[str, str]:
    """Load stored file hashes for a project. Returns {} if no hash file exists."""
    path = HASHES_DIR / f"{project_id}.json"
    if not path.exists():
        return {}
    with open(path, encoding="utf-8") as f:
        return json.load(f)


def save_hashes(project_id: str, hashes: dict[str, str]) -> None:
    """Persist file hashes for a project."""
    HASHES_DIR.mkdir(parents=True, exist_ok=True)
    path = HASHES_DIR / f"{project_id}.json"
    with open(path, "w", encoding="utf-8") as f:
        json.dump(hashes, f, indent=2, sort_keys=True)


def hash_file(path: Path) -> str:
    """Return SHA256 hex digest of a file's raw bytes."""
    h = hashlib.sha256()
    with open(path, "rb") as f:
        for chunk in iter(lambda: f.read(65536), b""):
            h.update(chunk)
    return h.hexdigest()


def delete_hashes(project_id: str) -> None:
    """Remove the hash file for a project (called on full reindex)."""
    path = HASHES_DIR / f"{project_id}.json"
    if path.exists():
        path.unlink()
