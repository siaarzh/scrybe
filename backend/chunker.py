import hashlib
from pathlib import Path
from typing import Iterator

from .config import settings
from .models import CodeChunk

EXTENSION_TO_LANGUAGE: dict[str, str] = {
    ".py": "python",
    ".ts": "typescript",
    ".tsx": "typescript",
    ".js": "javascript",
    ".jsx": "javascript",
    ".vue": "vue",
    ".kt": "kotlin",
    ".java": "java",
    ".cs": "csharp",
    ".go": "go",
    ".rs": "rust",
    ".rb": "ruby",
    ".php": "php",
    ".swift": "swift",
    ".cpp": "cpp",
    ".c": "c",
    ".h": "c",
    ".hpp": "cpp",
    ".html": "html",
    ".css": "css",
    ".scss": "scss",
    ".json": "json",
    ".yaml": "yaml",
    ".yml": "yaml",
    ".toml": "toml",
    ".md": "markdown",
    ".sh": "bash",
}

SKIP_DIRS = {
    ".git",
    ".svn",
    "node_modules",
    "__pycache__",
    ".venv",
    "venv",
    "dist",
    "build",
    ".next",
    ".nuxt",
    "coverage",
    ".pytest_cache",
    ".mypy_cache",
    ".ruff_cache",
    "target",
    # C# build output
    "bin",
    "obj",
    "packages",
    ".vs",
    "TestResults",
    "publish",
    "artifacts",
    # Vendored / embedded libraries
    "~ExternalLibraries",
    "Dommel",
    # Capacitor / mobile native
    "android",
    "ios",
    "electron",
    # CI/CD
    "fastlane",
}

SKIP_DIR_PREFIXES = (
    "Intra.Old.",
)  # legacy C# code, not relevant to current work

SKIP_EXTENSIONS = {
    ".lock",
    ".png",
    ".jpg",
    ".jpeg",
    ".gif",
    ".svg",
    ".ico",
    ".woff",
    ".woff2",
    ".ttf",
    ".eot",
    ".pdf",
    ".zip",
    ".tar",
    ".gz",
    ".map",
    ".min.js",
    ".min.css",
}

SKIP_FILENAMES = {
    # Lockfiles (various extensions, all auto-generated)
    "pnpm-lock.yaml",
    "yarn.lock",
    "package-lock.json",
    "Gemfile.lock",
    "Pipfile.lock",
    "composer.lock",
    "poetry.lock",
    "go.sum",
}


def _should_skip_dir(name: str) -> bool:
    if name in SKIP_DIRS or name.startswith("."):
        return True
    return any(name.startswith(p) for p in SKIP_DIR_PREFIXES)


def _get_language(path: Path) -> str | None:
    suffix = path.suffix.lower()
    # Handle compound extensions like .min.js
    if path.name.endswith(tuple(SKIP_EXTENSIONS)):
        return None
    return EXTENSION_TO_LANGUAGE.get(suffix)


def _load_gitignore(root: Path):
    gitignore_path = root / ".gitignore"
    if gitignore_path.exists():
        try:
            import gitignore_parser  # type: ignore[import-untyped]

            return gitignore_parser.parse_gitignore(gitignore_path)
        except Exception:
            pass
    return None


def _chunk_lines(
    lines: list[str], start_offset: int = 0
) -> list[tuple[int, int, str]]:
    """Split lines into overlapping chunks.
    Returns (start_line, end_line, content) tuples.
    """
    size = settings.chunk_size
    overlap = settings.chunk_overlap
    step = size - overlap
    chunks = []
    i = 0
    while i < len(lines):
        chunk_lines = lines[i : i + size]
        content = "".join(chunk_lines).strip()
        if content:
            chunks.append(
                (
                    start_offset + i + 1,
                    start_offset + i + len(chunk_lines),
                    content,
                )
            )
        i += step
    return chunks


def walk_repo_files(root_path: str) -> Iterator[tuple[str, Path]]:
    """
    Yield (rel_path, abs_path) for every indexable file in the repo.
    Applies the same skip rules as chunk_repo — no file reading or chunking.
    """
    root = Path(root_path)
    matches_gitignore = _load_gitignore(root)

    for path in sorted(root.rglob("*")):
        if not path.is_file():
            continue
        if any(
            _should_skip_dir(part)
            for part in path.relative_to(root).parts[:-1]
        ):
            continue
        if path.name in SKIP_FILENAMES:
            continue
        if matches_gitignore and matches_gitignore(str(path)):
            continue
        if _get_language(path) is None:
            continue
        rel_path = str(path.relative_to(root)).replace("\\", "/")
        yield rel_path, path


def chunk_repo(
    project_id: str,
    root_path: str,
    only_files: set[str] | None = None,
) -> Iterator[CodeChunk]:
    """
    Yield CodeChunk objects for every indexable file in the repo.
    Pass only_files to restrict chunking to a specific set of rel_paths.
    """
    for rel_path, path in walk_repo_files(root_path):
        if only_files is not None and rel_path not in only_files:
            continue

        try:
            text = path.read_text(encoding="utf-8", errors="ignore")
        except Exception:
            continue

        lines = text.splitlines(keepends=True)

        for start_line, end_line, content in _chunk_lines(lines):
            chunk_id = hashlib.sha256(
                f"{project_id}:{rel_path}:{start_line}:{end_line}".encode()
            ).hexdigest()

            yield CodeChunk(
                id=chunk_id,
                project_id=project_id,
                file_path=rel_path,
                content=content,
                start_line=start_line,
                end_line=end_line,
                language=_get_language(path) or "",
            )
