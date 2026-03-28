import { createHash } from "crypto";
import { readFileSync, readdirSync, existsSync } from "fs";
import { join, relative, extname, basename } from "path";
import ignore from "ignore";
import { config } from "./config.js";
import type { CodeChunk } from "./types.js";

// CJS interop: `ignore` module.exports is the factory function
type IgnoreManager = { add(patterns: string): void; ignores(path: string): boolean };
const createIgnore = ignore as unknown as () => IgnoreManager;

const EXTENSION_TO_LANGUAGE: Record<string, string> = {
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
};

const SKIP_DIRS = new Set([
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
  "bin",
  "obj",
  "packages",
  ".vs",
  "TestResults",
  "publish",
  "artifacts",
  "~ExternalLibraries",
  "Dommel",
  "android",
  "ios",
  "electron",
  "fastlane",
]);

const SKIP_DIR_PREFIXES = ["Intra.Old."];

const SKIP_EXTENSIONS = new Set([
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
]);

const SKIP_FILENAMES = new Set([
  "pnpm-lock.yaml",
  "yarn.lock",
  "package-lock.json",
  "Gemfile.lock",
  "Pipfile.lock",
  "composer.lock",
  "poetry.lock",
  "go.sum",
]);

function shouldSkipDir(name: string): boolean {
  if (name.startsWith(".")) return true;
  if (SKIP_DIRS.has(name)) return true;
  return SKIP_DIR_PREFIXES.some((p) => name.startsWith(p));
}

function getLanguage(filename: string): string | null {
  const name = basename(filename);
  if (name.endsWith(".min.js") || name.endsWith(".min.css")) return null;
  const ext = extname(name).toLowerCase();
  if (SKIP_EXTENSIONS.has(ext)) return null;
  return EXTENSION_TO_LANGUAGE[ext] ?? null;
}

function loadGitignore(rootPath: string): IgnoreManager | null {
  const gitignorePath = join(rootPath, ".gitignore");
  if (!existsSync(gitignorePath)) return null;
  try {
    const ig = createIgnore();
    ig.add(readFileSync(gitignorePath, "utf8"));
    return ig;
  } catch {
    return null;
  }
}

function chunkLines(
  lines: string[],
  startOffset = 0
): Array<{ start: number; end: number; content: string }> {
  const size = config.chunkSize;
  const overlap = config.chunkOverlap;
  const step = size - overlap;
  const result: Array<{ start: number; end: number; content: string }> = [];
  let i = 0;
  while (i < lines.length) {
    const slice = lines.slice(i, i + size);
    const content = slice.join("").trim();
    if (content) {
      result.push({
        start: startOffset + i + 1,
        end: startOffset + i + slice.length,
        content,
      });
    }
    i += step;
  }
  return result;
}

export function* walkRepoFiles(
  rootPath: string
): Generator<{ relPath: string; absPath: string }> {
  const ig = loadGitignore(rootPath);

  function* walk(dir: string): Generator<{ relPath: string; absPath: string }> {
    try {
      for (const entry of readdirSync(dir, { withFileTypes: true })) {
        const name = String(entry.name);
        const absPath = join(dir, name);
        const relPath = relative(rootPath, absPath).replace(/\\/g, "/");

        if (entry.isDirectory()) {
          if (shouldSkipDir(name)) continue;
          yield* walk(absPath);
        } else if (entry.isFile()) {
          if (SKIP_FILENAMES.has(name)) continue;
          if (getLanguage(name) === null) continue;
          if (ig?.ignores(relPath)) continue;
          yield { relPath, absPath };
        }
      }
    } catch {
      // unreadable directory — skip
    }
  }

  yield* walk(rootPath);
}

export function* chunkRepo(
  projectId: string,
  rootPath: string,
  onlyFiles?: Set<string>
): Generator<CodeChunk> {
  for (const { relPath, absPath } of walkRepoFiles(rootPath)) {
    if (onlyFiles !== undefined && !onlyFiles.has(relPath)) continue;

    let text: string;
    try {
      text = readFileSync(absPath, "utf8");
    } catch {
      continue;
    }

    const language = getLanguage(basename(absPath)) ?? "";
    const lines = text.split(/^/m);

    for (const { start, end, content } of chunkLines(lines)) {
      const chunkId = createHash("sha256")
        .update(`${projectId}:${relPath}:${start}:${end}`)
        .digest("hex");

      yield {
        chunk_id: chunkId,
        project_id: projectId,
        file_path: relPath,
        content,
        start_line: start,
        end_line: end,
        language,
        symbol_name: "",
      };
    }
  }
}
