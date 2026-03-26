import json
from pathlib import Path
from .models import Project

REGISTRY_PATH = Path(__file__).parent.parent / "projects.json"


def _load() -> list[dict]:
    if not REGISTRY_PATH.exists():
        return []
    return json.loads(REGISTRY_PATH.read_text(encoding="utf-8"))


def _save(projects: list[dict]) -> None:
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
    projects = [p for p in projects if p["id"] != project.id]
    projects.append(project.model_dump())
    _save(projects)


def remove_project(project_id: str) -> bool:
    projects = _load()
    filtered = [p for p in projects if p["id"] != project_id]
    if len(filtered) == len(projects):
        return False
    _save(filtered)
    return True
