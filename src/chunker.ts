import { createHash } from "crypto";
import { readFileSync, readdirSync } from "fs";
import { join, relative, extname, basename } from "path";
import { config } from "./config.js";
import { loadCanonicalIgnoreRules } from "./ignore-rules.js";
import { normalizeContent } from "./normalize.js";
import type { CodeChunk, RawChunk, StampedChunk } from "./types.js";


const EXTENSION_TO_LANGUAGE: Record<string, string> = {
  ".py": "python",
  ".ts": "typescript",
  ".tsx": "tsx",
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
  "vendor",
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

export function getLanguage(filename: string): string | null {
  const name = basename(filename);
  if (name.endsWith(".min.js") || name.endsWith(".min.css")) return null;
  // Auto-generated C# files
  if (name.endsWith(".g.cs") || name.endsWith(".designer.cs") || name.endsWith(".Designer.cs") || name.endsWith(".generated.cs")) return null;
  const ext = extname(name).toLowerCase();
  if (SKIP_EXTENSIONS.has(ext)) return null;
  return EXTENSION_TO_LANGUAGE[ext] ?? null;
}

export function chunkLines(
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
  rootPath: string,
  projectId?: string,
  sourceId?: string
): Generator<{ relPath: string; absPath: string }> {
  const rules = loadCanonicalIgnoreRules(rootPath, projectId, sourceId);
  const { forcePatterns } = rules;

  function dirMightContainForceIncludes(dirRelPath: string): boolean {
    const prefix = dirRelPath + "/";
    return forcePatterns.some(p => p === dirRelPath || p === prefix || p.startsWith(prefix));
  }

  function* walk(dir: string): Generator<{ relPath: string; absPath: string }> {
    try {
      for (const entry of readdirSync(dir, { withFileTypes: true })) {
        const name = String(entry.name);
        const absPath = join(dir, name);
        const relPath = relative(rootPath, absPath).replace(/\\/g, "/");

        if (entry.isDirectory()) {
          if (shouldSkipDir(name) && !dirMightContainForceIncludes(relPath)) continue;
          yield* walk(absPath);
        } else if (entry.isFile()) {
          const forceIn = rules.isForceIncluded(relPath);
          if (!forceIn && SKIP_FILENAMES.has(name)) continue;
          if (!forceIn && getLanguage(name) === null) continue;
          if (rules.shouldIgnore(relPath)) continue;
          yield { relPath, absPath };
        }
      }
    } catch {
      // unreadable directory — skip
    }
  }

  yield* walk(rootPath);
}

function makeChunkId(
  projectId: string,
  sourceId: string,
  itemPath: string,
  itemUrl: string,
  itemType: string,
  content: string
): string {
  return createHash("sha256")
    .update(projectId + "\0" + sourceId + "\0" + itemPath + "\0" + itemUrl + "\0" + itemType + "\0" + content)
    .digest("hex");
}

/** Central chunk-ID stamping: accepts a RawChunk, returns a StampedChunk with chunk_id set. */
export function stampChunkId(raw: RawChunk): StampedChunk {
  const chunk_id = makeChunkId(
    raw.project_id,
    raw.source_id,
    raw.item_path,
    raw.item_url,
    raw.item_type,
    raw.content,
  );
  return { ...raw, chunk_id } as StampedChunk;
}

export function* chunkRepo(
  projectId: string,
  sourceId: string,
  rootPath: string,
  onlyFiles?: Set<string>
): Generator<CodeChunk> {
  for (const { relPath, absPath } of walkRepoFiles(rootPath, projectId, sourceId)) {
    if (onlyFiles !== undefined && !onlyFiles.has(relPath)) continue;

    let text: string;
    try {
      text = normalizeContent(readFileSync(absPath, "utf8"));
    } catch {
      continue;
    }

    const language = getLanguage(basename(absPath)) ?? "";
    const lines = text.split(/^/m);

    for (const { start, end, content } of chunkLines(lines)) {
      yield stampChunkId({
        project_id: projectId,
        source_id: sourceId,
        item_path: relPath,
        item_url: "",
        item_type: "code",
        content,
        start_line: start,
        end_line: end,
        language,
        symbol_name: "",
      }) as CodeChunk;
    }
  }
}
