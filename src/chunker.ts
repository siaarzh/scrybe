import { createHash } from "crypto";
import { readFileSync, readdirSync, existsSync } from "fs";
import { join, relative, extname, basename } from "path";
import ignore from "ignore";
import { config } from "./config.js";
import { loadPrivateIgnore } from "./private-ignore.js";
import type { CodeChunk } from "./types.js";

// CJS interop: `ignore` module.exports is the factory function
type IgnoreManager = { add(patterns: string): void; ignores(path: string): boolean };
const createIgnore = ignore as unknown as () => IgnoreManager;

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

function loadIgnoreRules(
  rootPath: string,
  projectId?: string,
  sourceId?: string
): { ig: IgnoreManager | null; forcePatterns: string[] } {
  const ig = createIgnore();
  let hasRules = false;
  const forcePatterns: string[] = [];

  // .gitignore first (base rules)
  const gitignorePath = join(rootPath, ".gitignore");
  if (existsSync(gitignorePath)) {
    try { ig.add(readFileSync(gitignorePath, "utf8")); hasRules = true; } catch {}
  }

  // .scrybeignore on top — can add excludes or negate .gitignore rules via !pattern
  const scrybeignorePath = join(rootPath, ".scrybeignore");
  if (existsSync(scrybeignorePath)) {
    try {
      const content = readFileSync(scrybeignorePath, "utf8");
      ig.add(content);
      hasRules = true;
      // Collect negation patterns (stripped of !) — used to override hardcoded SKIP_DIRS etc.
      for (const line of content.split(/\r?\n/)) {
        const trimmed = line.trim();
        if (trimmed.startsWith("!") && trimmed.length > 1) forcePatterns.push(trimmed.slice(1));
      }
    } catch {}
  }

  // Private ignore on top — DATA_DIR/ignores/<project>/<source>.gitignore
  if (projectId && sourceId) {
    const privateContent = loadPrivateIgnore(projectId, sourceId);
    if (privateContent) {
      try {
        ig.add(privateContent);
        hasRules = true;
        // Collect negation patterns from private ignore too
        for (const line of privateContent.split(/\r?\n/)) {
          const trimmed = line.trim();
          if (trimmed.startsWith("!") && trimmed.length > 1) forcePatterns.push(trimmed.slice(1));
        }
      } catch {}
    }
  }

  return { ig: hasRules ? ig : null, forcePatterns };
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
  const { ig, forcePatterns } = loadIgnoreRules(rootPath, projectId, sourceId);

  // Build force-include checker from negation patterns — overrides hardcoded skips
  let forceInclude: IgnoreManager | null = null;
  if (forcePatterns.length > 0) {
    forceInclude = createIgnore();
    forceInclude.add(forcePatterns.join("\n"));
  }

  // Returns true if relPath matches a !pattern in .scrybeignore
  function isForceIncluded(relPath: string): boolean {
    return forceInclude?.ignores(relPath) === true;
  }

  // Returns true if any force-include pattern targets something inside this dir
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
          const forceIn = isForceIncluded(relPath);
          if (!forceIn && SKIP_FILENAMES.has(name)) continue;
          if (!forceIn && getLanguage(name) === null) continue;
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

export function makeChunkId(
  projectId: string,
  sourceId: string,
  language: string,
  content: string
): string {
  return createHash("sha256")
    .update(projectId + "\0" + sourceId + "\0" + language + "\0" + content)
    .digest("hex");
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
      text = readFileSync(absPath, "utf8");
    } catch {
      continue;
    }

    const language = getLanguage(basename(absPath)) ?? "";
    const lines = text.split(/^/m);

    for (const { start, end, content } of chunkLines(lines)) {
      yield {
        chunk_id: makeChunkId(projectId, sourceId, language, content),
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
