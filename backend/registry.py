import json

from .config import DATA_DIR
from .models import Project

REGISTRY_PATH = DATA_DIR / "projects.json"


def _load() -> list[dict]:
    if not REGISTRY_PATH.exists():
        return []
    return json.loads(REGISTRY_PATH.read_text(encoding="utf-8"))


def _save(projects: list[dict]) -> None:
    DATA_DIR.mkdir(parents=True, exist_ok=True)
    REGISTRY_PATH.write_text(
        json.dumps(projects, indent=2, ensure_ascii=False),
        encoding="utf-8",
    )


def list_projects() -> list[Project]:
    return [Project(**p) for p in _load()]


def get_project(project_id: str) -> Project | None:
    for p in _load():
        if p["id"] == project_id:
            return Project(**p)
    return None


def add_project(project: Project) -> None:
    projects = _load()
    if any(p["id"] == project.id for p in projects):
        raise ValueError(
            f"Project '{project.id}' already exists. Use update_project"
            f" to modify it."
        )
    projects.append(project.model_dump())
    _save(projects)


def update_project(
    project_id: str,
    root_path: str | None = None,
    languages: list[str] | None = None,
    description: str | None = None,
) -> Project:
    projects = _load()
    for p in projects:
        if p["id"] == project_id:
            if root_path is not None:
                p["root_path"] = root_path
            if languages is not None:
                p["languages"] = languages
            if description is not None:
                p["description"] = description
            _save(projects)
            return Project(**p)
    raise ValueError(
        f"Project '{project_id}' not found. Use add_project to register it."
    )


def remove_project(project_id: str) -> bool:
    projects = _load()
    filtered = [p for p in projects if p["id"] != project_id]
    if len(filtered) == len(projects):
        return False
    _save(filtered)
    return True
