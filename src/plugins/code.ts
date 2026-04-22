import { createRequire } from "module";
import { execSync } from "child_process";
import { readFileSync } from "fs";
import { basename } from "path";
import { walkRepoFiles, chunkLines, getLanguage, makeChunkId } from "../chunker.js";
import { hashFile } from "../hashes.js";
import { config } from "../config.js";
import type { CodeChunk, Project, Source, SourceConfig } from "../types.js";
import type { SourcePlugin, AnyChunk } from "./base.js";

// ─── Tree-sitter types (duck-typed; loaded lazily via CJS require) ───────────

interface TsNode {
  type: string;
  text: string;
  startPosition: { row: number; column: number };
  endPosition: { row: number; column: number };
  startIndex: number;
  endIndex: number;
  children: TsNode[];
  namedChildren: TsNode[];
  childForFieldName(name: string): TsNode | null;
}

interface TsTree {
  rootNode: TsNode;
}

interface TsParser {
  setLanguage(lang: unknown): void;
  parse(source: string): TsTree;
}

interface TsParserCtor {
  new (): TsParser;
}

// ─── Lazy tree-sitter initialisation ─────────────────────────────────────────

type LanguageKey = "typescript" | "tsx" | "javascript" | "csharp" | "python"
  | "go" | "rust" | "java" | "ruby" | "c" | "cpp";

let _parserCtor: TsParserCtor | null = null;
const _languages = new Map<LanguageKey, unknown>();
let _initDone = false;

function tryInitTreeSitter(): void {
  if (_initDone) return;
  _initDone = true;
  try {
    const req = createRequire(import.meta.url);
    _parserCtor = req("tree-sitter") as TsParserCtor;
    const ts = req("tree-sitter-typescript") as { typescript: unknown; tsx: unknown };
    _languages.set("typescript", ts.typescript);
    _languages.set("tsx", ts.tsx);
    _languages.set("javascript", req("tree-sitter-javascript"));
    _languages.set("csharp", req("tree-sitter-c-sharp"));
    _languages.set("python", req("tree-sitter-python"));
    _languages.set("go", req("tree-sitter-go"));
    _languages.set("rust", req("tree-sitter-rust"));
    _languages.set("java", req("tree-sitter-java"));
    _languages.set("ruby", req("tree-sitter-ruby"));
    _languages.set("c", req("tree-sitter-c"));
    _languages.set("cpp", req("tree-sitter-cpp"));
  } catch {
    // tree-sitter native bindings unavailable — fall back to sliding-window for all files
    _parserCtor = null;
  }
}

function getParser(lang: string): TsParser | null {
  if (!_parserCtor) return null;
  const langKey = LANGUAGE_TO_KEY[lang];
  if (!langKey) return null;
  const grammar = _languages.get(langKey);
  if (!grammar) return null;
  const parser = new _parserCtor();
  parser.setLanguage(grammar);
  return parser;
}

// Languages with AST chunking (function/class-level chunks + symbol_name).
// All other languages in chunker.ts EXTENSION_TO_LANGUAGE fall back to sliding-window,
// which still indexes their content but produces no symbol_name.
//
// Notable omission: html, css, scss — tree-sitter grammars exist but these languages
// have no function/class declarations, so AST chunking adds no value over sliding-window.
// This is a minor limitation for large single-page sites (one big HTML + one big CSS file)
// where chunk boundaries are arbitrary rather than semantic. If this becomes a problem,
// consider a custom chunker that splits HTML by top-level elements and CSS by rule blocks.
const LANGUAGE_TO_KEY: Record<string, LanguageKey> = {
  typescript: "typescript",
  javascript: "javascript",
  csharp: "csharp",
  python: "python",
  go: "go",
  rust: "rust",
  java: "java",
  ruby: "ruby",
  c: "c",
  cpp: "cpp",
};

// Vue: extract <script lang="ts"> or <script> block content, parse as TypeScript
function extractVueScript(source: string): { code: string; lineOffset: number } | null {
  const match = source.match(/<script(?:\s[^>]*)?>(\n?)([\s\S]*?)<\/script>/i);
  if (!match) return null;
  const lineOffset = source.slice(0, match.index! + match[0].indexOf(match[2])).split("\n").length - 1;
  return { code: match[2], lineOffset };
}

// ─── AST chunk extraction ─────────────────────────────────────────────────────

/**
 * Node types to treat as named declarations per language.
 * Walker will emit these as individual chunks.
 * Class-like types get special treatment: we also recurse into their body.
 */
const DECLARATION_TYPES: Record<LanguageKey, Set<string>> = {
  typescript: new Set([
    "function_declaration",
    "method_definition",
    "class_declaration",
    "interface_declaration",
    "type_alias_declaration",
    "enum_declaration",
  ]),
  tsx: new Set([
    "function_declaration",
    "method_definition",
    "class_declaration",
    "interface_declaration",
    "type_alias_declaration",
    "enum_declaration",
  ]),
  javascript: new Set([
    "function_declaration",
    "method_definition",
    "class_declaration",
  ]),
  csharp: new Set([
    "class_declaration",
    "interface_declaration",
    "method_declaration",
    "constructor_declaration",
  ]),
  python: new Set([
    "function_definition",
    "class_definition",
  ]),
  go: new Set([
    "function_declaration",  // func foo()
    "method_declaration",    // func (r Receiver) foo()
    "type_declaration",      // type Foo struct/interface
  ]),
  rust: new Set([
    "function_item",         // fn foo()
    "impl_item",             // impl Foo — recurse for methods
    "struct_item",           // struct Foo
    "enum_item",             // enum Foo
    "trait_item",            // trait Foo
  ]),
  java: new Set([
    "class_declaration",
    "interface_declaration",
    "enum_declaration",
    "method_declaration",
    "constructor_declaration",
  ]),
  ruby: new Set([
    "method",                // def foo
    "singleton_method",      // def self.foo
    "class",                 // class Foo
    "module",                // module Foo
  ]),
  // C/C++: function_definition uses a nested declarator pattern.
  // getNodeName falls back to scanning children for an identifier — good enough.
  c: new Set([
    "function_definition",
  ]),
  cpp: new Set([
    "function_definition",
    "class_specifier",
    "struct_specifier",
  ]),
};

const CLASS_LIKE_TYPES = new Set([
  "class_declaration",   // TS, JS, Java, C#, Ruby
  "interface_declaration",
  "class_definition",    // Python
  "impl_item",           // Rust
  "class_specifier",     // C++
  "struct_specifier",    // C++
]);

function getNodeName(node: TsNode): string {
  // Try field-based lookup first (most reliable)
  const nameNode =
    node.childForFieldName("name") ??
    node.children.find(
      (c) =>
        c.type === "identifier" ||
        c.type === "type_identifier" ||
        c.type === "property_identifier"
    );
  return nameNode?.text ?? "";
}

interface DeclEntry {
  symbolName: string;
  startLine: number; // 0-indexed
  endLine: number;   // 0-indexed, inclusive
  content: string;
}

function walkDeclarations(
  node: TsNode,
  declTypes: Set<string>,
  source: string,
  lineOffset: number,
  parentName?: string
): DeclEntry[] {
  const results: DeclEntry[] = [];

  if (declTypes.has(node.type)) {
    const name = getNodeName(node);
    const symbolName = parentName && name ? `${parentName}.${name}` : (name || "");

    results.push({
      symbolName,
      startLine: node.startPosition.row + lineOffset,
      endLine: node.endPosition.row + lineOffset,
      content: source.slice(node.startIndex, node.endIndex),
    });

    // For class-like nodes: recurse into body to pick up methods
    if (CLASS_LIKE_TYPES.has(node.type)) {
      for (const child of node.namedChildren) {
        results.push(...walkDeclarations(child, declTypes, source, lineOffset, symbolName));
      }
    }
    // Don't recurse into function bodies — avoids double-indexing nested helpers
    return results;
  }

  // Not a declaration — keep looking deeper
  for (const child of node.namedChildren) {
    results.push(...walkDeclarations(child, declTypes, source, lineOffset, parentName));
  }
  return results;
}

function astChunks(
  projectId: string,
  sourceId: string,
  relPath: string,
  source: string,
  langKey: LanguageKey,
  lineOffset: number,
  parser: TsParser
): CodeChunk[] {
  const declTypes = DECLARATION_TYPES[langKey];
  let tree: TsTree;
  try {
    tree = parser.parse(source);
  } catch {
    return [];
  }

  const decls = walkDeclarations(tree.rootNode, declTypes, source, lineOffset);
  if (decls.length === 0) return [];

  const chunks: CodeChunk[] = [];
  const lines = source.split(/^/m);

  for (const decl of decls) {
    const declLines = decl.endLine - decl.startLine + 1;
    if (declLines <= config.chunkSize) {
      const content = decl.content.trim();
      chunks.push({
        chunk_id: makeChunkId(projectId, sourceId, langKey, content),
        project_id: projectId,
        file_path: relPath,
        content,
        start_line: decl.startLine + 1,
        end_line: decl.endLine + 1,
        language: langKey,
        symbol_name: decl.symbolName,
      });
    } else {
      // Too large — split with sliding window, keep symbol_name on first sub-chunk
      const declLineSlice = lines.slice(decl.startLine, decl.endLine + 1);
      let first = true;
      for (const window of chunkLines(declLineSlice, decl.startLine)) {
        chunks.push({
          chunk_id: makeChunkId(projectId, sourceId, langKey, window.content),
          project_id: projectId,
          file_path: relPath,
          content: window.content,
          start_line: window.start,
          end_line: window.end,
          language: langKey,
          symbol_name: first ? decl.symbolName : "",
        });
        first = false;
      }
    }
  }

  return chunks;
}

// ─── Sliding-window fallback ──────────────────────────────────────────────────

function slidingWindowChunks(
  projectId: string,
  sourceId: string,
  relPath: string,
  source: string,
  language: string
): CodeChunk[] {
  const lines = source.split(/^/m);
  const chunks: CodeChunk[] = [];
  for (const { start, end, content } of chunkLines(lines)) {
    chunks.push({
      chunk_id: makeChunkId(projectId, sourceId, language, content),
      project_id: projectId,
      file_path: relPath,
      content,
      start_line: start,
      end_line: end,
      language,
      symbol_name: "",
    });
  }
  return chunks;
}

// ─── Branch-aware scanner (Contract 11) ──────────────────────────────────────

export interface ScanEntry {
  relPath: string;
  content: string;
  size: number;
  mode: number;  // git object mode; 120000=symlink, 160000=submodule (skipped in impl)
}

/**
 * Yields file entries for a repo path, either from the working tree or a git ref.
 *
 * - `branch === undefined`: walks the working tree via walkRepoFiles (same as normal index)
 * - `branch` set: runs `git ls-tree` to enumerate the ref, reads content via `git show`
 *
 * Contract 11 export — consumed by M-D2 daemon for branch-switch and remote-push workflows.
 */
export async function* scanRef(
  repoPath: string,
  branch?: string
): AsyncGenerator<ScanEntry> {
  if (!branch) {
    for (const { relPath, absPath } of walkRepoFiles(repoPath)) {
      let content: string;
      try {
        content = readFileSync(absPath, "utf8");
      } catch {
        continue;
      }
      yield { relPath, content, size: Buffer.byteLength(content, "utf8"), mode: 0o100644 };
    }
    return;
  }

  // git ls-tree path — enumerate files from git ref
  let lsOutput: string;
  try {
    lsOutput = execSync(`git ls-tree --full-tree -r -z "${branch}"`, {
      cwd: repoPath,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
      maxBuffer: 50 * 1024 * 1024,
    });
  } catch {
    return;
  }

  const MAX_FILE_BYTES = parseInt(process.env["SCRYBE_MAX_FILE_BYTES"] ?? "0", 10) || 1 * 1024 * 1024;

  for (const entry of lsOutput.split("\0").filter(Boolean)) {
    // format: "<mode> <type> <hash>\t<path>"
    const tabIdx = entry.indexOf("\t");
    if (tabIdx === -1) continue;
    const meta = entry.slice(0, tabIdx);
    const relPath = entry.slice(tabIdx + 1);
    const mode = parseInt(meta.split(" ")[0], 8);

    // Skip symlinks (120000) and submodules (160000)
    if (mode === 0o120000 || mode === 0o160000) continue;

    // Skip files with no known language (mirrors walkRepoFiles filtering)
    if (!getLanguage(basename(relPath))) continue;

    let content: string;
    try {
      content = execSync(`git show "${branch}:${relPath}"`, {
        cwd: repoPath,
        encoding: "utf8",
        stdio: ["ignore", "pipe", "ignore"],
        maxBuffer: MAX_FILE_BYTES,
      });
    } catch {
      continue;
    }

    const size = Buffer.byteLength(content, "utf8");
    if (size > MAX_FILE_BYTES) continue;

    yield { relPath, content, size, mode };
  }
}

// ─── Plugin ───────────────────────────────────────────────────────────────────

export class CodePlugin implements SourcePlugin {
  readonly type = "code";
  readonly embeddingProfile = "code" as const;

  async scanSources(project: Project, source: Source, _cursor?: string | null): Promise<Record<string, string>> {
    const cfg = source.source_config as Extract<SourceConfig, { type: "code" }>;
    const BATCH_SIZE = parseInt(process.env.SCRYBE_SCAN_CONCURRENCY ?? "32", 10);
    const files = [...walkRepoFiles(cfg.root_path)];
    const result: Record<string, string> = {};

    for (let i = 0; i < files.length; i += BATCH_SIZE) {
      const batch = files.slice(i, i + BATCH_SIZE);
      const settled = await Promise.allSettled(
        batch.map(async ({ relPath, absPath }) => {
          const hash = await hashFile(absPath);
          return { relPath, hash };
        })
      );
      for (const entry of settled) {
        if (entry.status === "fulfilled") {
          result[entry.value.relPath] = entry.value.hash;
        }
      }
    }

    return result;
  }

  async *fetchChunks(project: Project, source: Source, changed: Set<string>): AsyncGenerator<AnyChunk> {
    const cfg = source.source_config as Extract<SourceConfig, { type: "code" }>;
    const sourceId = source.source_id;

    for (const { relPath, absPath } of walkRepoFiles(cfg.root_path)) {
      if (!changed.has(relPath)) continue;

      let fileSource: string;
      try {
        fileSource = readFileSync(absPath, "utf8");
      } catch {
        continue;
      }

      const lang = getLanguage(basename(absPath)) ?? "";
      yield* chunkFileContent(project.id, sourceId, relPath, fileSource, lang) as AnyChunk[];
    }
  }
}

// ─── Exported chunker — used by daemon for non-HEAD branch indexing ───────────

/**
 * Chunks file content into CodeChunk[].
 * Exported so the daemon can chunk content read from git objects (via scanRef)
 * rather than from the working tree.
 */
export function chunkFileContent(
  projectId: string,
  sourceId: string,
  relPath: string,
  source: string,
  language: string
): CodeChunk[] {
  tryInitTreeSitter();
  // Vue: extract <script> block, parse as TypeScript
  if (language === "vue") {
    const extracted = extractVueScript(source);
    if (extracted) {
      const parser = getParser("typescript");
      if (parser) {
        const chunks = astChunks(projectId, sourceId, relPath, extracted.code, "typescript", extracted.lineOffset, parser);
        if (chunks.length > 0) return chunks;
      }
    }
    return slidingWindowChunks(projectId, sourceId, relPath, source, language);
  }

  const langKey = LANGUAGE_TO_KEY[language];
  if (langKey) {
    const parser = getParser(language);
    if (parser) {
      const chunks = astChunks(projectId, sourceId, relPath, source, langKey, 0, parser);
      if (chunks.length > 0) return chunks;
    }
  }

  return slidingWindowChunks(projectId, sourceId, relPath, source, language);
}
