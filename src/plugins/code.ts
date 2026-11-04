import { createRequire } from "module";
import { createReadStream, readFileSync } from "fs";
import { basename } from "path";
import { createHash } from "node:crypto";
import { walkRepoFiles, chunkLines, getLanguage, stampChunkId } from "../chunker.js";
import { loadCanonicalIgnoreRules } from "../ignore-rules.js";
import { normalizeContent } from "../normalize.js";
import { gitExec } from "../util/git-exec.js";
import { config } from "../config.js";
import { diagEmit } from "../daemon/events.js";

function hashFile(filePath: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const hash = createHash("sha256");
    const stream = createReadStream(filePath);
    stream.on("data", (chunk) => hash.update(chunk));
    stream.on("end", () => resolve(hash.digest("hex")));
    stream.on("error", reject);
  });
}
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
  parse(source: string, oldTree?: undefined, options?: { bufferSize?: number }): TsTree;
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
  const match = source.match(/<script(?:\s[^>]*)?>(\n?)([\s\S]*?)<\/script[^>]*>/i);
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

/** Top-level code that is not a declaration; rows are 0-indexed and include lineOffset. */
interface GapNode {
  node: TsNode;
  startRow: number;
  endRow: number;
  keep: boolean;
}

const COMMENT_TYPES = new Set(["comment", "line_comment", "block_comment"]);

const IMPORT_TYPES: Record<LanguageKey, Set<string>> = {
  typescript: new Set(["import_statement"]),
  tsx: new Set(["import_statement"]),
  javascript: new Set(["import_statement"]),
  csharp: new Set(["using_directive", "extern_alias_directive"]),
  python: new Set(["import_statement", "import_from_statement", "future_import_statement"]),
  go: new Set(["package_clause", "import_declaration"]),
  rust: new Set(["use_declaration", "extern_crate_declaration"]),
  java: new Set(["package_declaration", "import_declaration"]),
  ruby: new Set(),
  c: new Set(["preproc_include"]),
  cpp: new Set(["preproc_include"]),
};

function isNoiseNode(node: TsNode, langKey: LanguageKey): boolean {
  if (COMMENT_TYPES.has(node.type)) return true;
  if (IMPORT_TYPES[langKey].has(node.type)) return true;
  if (node.type === "export_statement") {
    return node.children.some((c) => c.type === "export_clause") || node.childForFieldName("source") !== null;
  }
  return false;
}

// Name/header tokens of a container (namespace, module) are not code of their own.
function isHeaderToken(node: TsNode): boolean {
  return node.type.endsWith("identifier") || node.type === "qualified_name" || node.type === "name";
}

interface WalkCtx {
  declTypes: Set<string>;
  langKey: LanguageKey;
  source: string;
  lineOffset: number;
  decls: DeclEntry[];
  gaps: GapNode[];
}

/** One pass: collects declarations (pre-order) and leftover gap nodes. Returns true if a declaration lies at or below `node`. */
function walkNode(node: TsNode, ctx: WalkCtx, isRoot: boolean, collectGaps: boolean, parentName?: string): boolean {
  if (ctx.declTypes.has(node.type)) {
    const name = getNodeName(node);
    const symbolName = parentName && name ? `${parentName}.${name}` : (name || "");

    ctx.decls.push({
      symbolName,
      startLine: node.startPosition.row + ctx.lineOffset,
      endLine: node.endPosition.row + ctx.lineOffset,
      content: ctx.source.slice(node.startIndex, node.endIndex),
    });

    // For class-like nodes: recurse into body to pick up methods
    if (CLASS_LIKE_TYPES.has(node.type)) {
      for (const child of node.namedChildren) {
        walkNode(child, ctx, false, false, symbolName);
      }
    }
    // Don't recurse into function bodies — avoids double-indexing nested helpers
    return true;
  }

  const mark = ctx.gaps.length;
  let hasDecl = false;
  for (const child of node.namedChildren) {
    if (walkNode(child, ctx, false, collectGaps, parentName)) hasDecl = true;
  }

  if (hasDecl) {
    if (collectGaps) {
      const direct = new Set(node.namedChildren);
      let w = mark;
      for (let r = mark; r < ctx.gaps.length; r++) {
        const g = ctx.gaps[r];
        if (!(direct.has(g.node) && isHeaderToken(g.node))) ctx.gaps[w++] = g;
      }
      ctx.gaps.length = w;
    }
    return true;
  }

  if (collectGaps && !isRoot) {
    ctx.gaps.length = mark;
    ctx.gaps.push({
      node,
      startRow: node.startPosition.row + ctx.lineOffset,
      endRow: node.endPosition.row + ctx.lineOffset,
      keep: !isNoiseNode(node, ctx.langKey),
    });
  }
  return false;
}

// tree-sitter's default string input buffer throws at 32,768 chars.
const MIN_PARSE_BUFFER = 32 * 1024;

function astChunks(
  projectId: string,
  sourceId: string,
  relPath: string,
  source: string,
  langKey: LanguageKey,
  lineOffset: number,
  parser: TsParser,
  maxChars?: number
): CodeChunk[] {
  const declTypes = DECLARATION_TYPES[langKey];
  let tree: TsTree;
  try {
    tree = parser.parse(source, undefined, { bufferSize: Math.max(MIN_PARSE_BUFFER, source.length * 2) });
  } catch (err) {
    diagEmit({
      event: "chunker.parse_failed",
      level: "warn",
      projectId,
      path: relPath,
      language: langKey,
      chars: source.length,
      message: err instanceof Error ? err.message : String(err),
    });
    return [];
  }

  const ctx: WalkCtx = { declTypes, langKey, source, lineOffset, decls: [], gaps: [] };
  walkNode(tree.rootNode, ctx, true, true);
  const decls = ctx.decls;
  if (decls.length === 0) return [];

  const chunks: CodeChunk[] = [];
  const lines = source.split(/^/m);

  for (const decl of decls) {
    const declLines = decl.endLine - decl.startLine + 1;
    const declContent = decl.content.trim();
    // Split if the declaration exceeds line-count limit OR char cap
    const fitsInOneLine = declLines <= config.chunkSize &&
      (maxChars === undefined || declContent.length <= maxChars);
    if (fitsInOneLine) {
      chunks.push(stampChunkId({
        project_id: projectId,
        source_id: sourceId,
        item_path: relPath,
        item_url: "",
        item_type: "code",
        content: declContent,
        start_line: decl.startLine + 1,
        end_line: decl.endLine + 1,
        language: langKey,
        symbol_name: decl.symbolName,
      }) as CodeChunk);
    } else {
      // Too large — split with sliding window, keep symbol_name on first sub-chunk
      const declLineSlice = lines.slice(decl.startLine - lineOffset, decl.endLine - lineOffset + 1);
      let first = true;
      for (const window of chunkLines(declLineSlice, decl.startLine, maxChars)) {
        chunks.push(stampChunkId({
          project_id: projectId,
          source_id: sourceId,
          item_path: relPath,
          item_url: "",
          item_type: "code",
          content: window.content,
          start_line: window.start,
          end_line: window.end,
          language: langKey,
          symbol_name: first ? decl.symbolName : "",
        }) as CodeChunk);
        first = false;
      }
    }
  }

  for (const region of gapRegions(ctx.gaps, decls)) {
    const regionLines = lines.slice(region.start - lineOffset, region.end - lineOffset + 1);
    for (const window of chunkLines(regionLines, region.start, maxChars)) {
      chunks.push(stampChunkId({
        project_id: projectId,
        source_id: sourceId,
        item_path: relPath,
        item_url: "",
        item_type: "code",
        content: window.content,
        start_line: window.start,
        end_line: window.end,
        language: langKey,
        symbol_name: "",
      }) as CodeChunk);
    }
  }

  return chunks;
}

/** Merges leftover nodes into whole-line regions (0-indexed, inclusive) that avoid declaration lines and hold at least one non-noise node. */
function gapRegions(gaps: GapNode[], decls: DeclEntry[]): Array<{ start: number; end: number }> {
  if (gaps.length === 0) return [];
  const covered = new Set<number>();
  for (const d of decls) for (let r = d.startLine; r <= d.endLine; r++) covered.add(r);

  const sorted = [...gaps].sort((a, b) => a.startRow - b.startRow);
  const groups: GapNode[][] = [];
  let cur: GapNode[] = [];
  let curEnd = -1;
  for (const g of sorted) {
    let separated = false;
    if (cur.length > 0) {
      for (let r = curEnd + 1; r < g.startRow; r++) {
        if (covered.has(r)) { separated = true; break; }
      }
    }
    if (cur.length > 0 && separated) {
      groups.push(cur);
      cur = [];
      curEnd = -1;
    }
    cur.push(g);
    curEnd = Math.max(curEnd, g.endRow);
  }
  if (cur.length > 0) groups.push(cur);

  const regions: Array<{ start: number; end: number }> = [];
  for (const group of groups) {
    const first = Math.min(...group.map((g) => g.startRow));
    const last = Math.max(...group.map((g) => g.endRow));
    let runStart = -1;
    const flush = (runEnd: number) => {
      if (runStart < 0) return;
      const rs = runStart;
      runStart = -1;
      const kept = group.filter((g) => g.keep && g.startRow <= runEnd && g.endRow >= rs);
      if (kept.length === 0) return;
      // Start and end on real code, so leading imports and comments stay out.
      regions.push({
        start: Math.max(rs, Math.min(...kept.map((g) => g.startRow))),
        end: Math.min(runEnd, Math.max(...kept.map((g) => g.endRow))),
      });
    };
    for (let r = first; r <= last; r++) {
      if (covered.has(r)) flush(r - 1);
      else if (runStart < 0) runStart = r;
    }
    flush(last);
  }
  return regions;
}

// ─── Sliding-window fallback ──────────────────────────────────────────────────

function slidingWindowChunks(
  projectId: string,
  sourceId: string,
  relPath: string,
  source: string,
  language: string,
  maxChars?: number
): CodeChunk[] {
  const lines = source.split(/^/m);
  const chunks: CodeChunk[] = [];
  for (const { start, end, content } of chunkLines(lines, 0, maxChars)) {
    chunks.push(stampChunkId({
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
    }) as CodeChunk);
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
 *
 * projectId / sourceId: when provided, apply committed .scrybeignore (from working tree)
 * and the private ignore (from DATA_DIR) to the git ls-tree output.
 */
export async function* scanRef(
  repoPath: string,
  branch?: string,
  projectId?: string,
  sourceId?: string
): AsyncGenerator<ScanEntry> {
  if (!branch) {
    for (const { relPath, absPath } of walkRepoFiles(repoPath, projectId, sourceId)) {
      let content: string;
      try {
        content = normalizeContent(readFileSync(absPath, "utf8"));
      } catch {
        continue;
      }
      yield { relPath, content, size: Buffer.byteLength(content, "utf8"), mode: 0o100644 };
    }
    return;
  }

  const ignoreRules = loadCanonicalIgnoreRules(repoPath, projectId, sourceId);

  // git ls-tree path — enumerate files from git ref
  const lsOutput = gitExec(
    ["ls-tree", "--full-tree", "-r", "-z", branch],
    { cwd: repoPath, trim: false, maxBuffer: 50 * 1024 * 1024 },
  );
  if (lsOutput === null) return;

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

    if (ignoreRules.shouldIgnore(relPath)) continue;

    const raw = gitExec(
      ["show", `${branch}:${relPath}`],
      { cwd: repoPath, trim: false, maxBuffer: MAX_FILE_BYTES },
    );
    if (raw === null) continue;

    const content = normalizeContent(raw);
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
    const files = [...walkRepoFiles(cfg.root_path, project.id, source.source_id)];
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

    for (const { relPath, absPath } of walkRepoFiles(cfg.root_path, project.id, sourceId)) {
      if (!changed.has(relPath)) continue;

      let fileSource: string;
      try {
        fileSource = normalizeContent(readFileSync(absPath, "utf8"));
      } catch {
        continue;
      }

      const lang = getLanguage(basename(absPath)) ?? "";
      yield* chunkFileContent(project.id, sourceId, relPath, fileSource, lang) as AnyChunk[];
    }
  }
}

// ─── Exported chunker — used by daemon for non-HEAD branch indexing ───────────

const GENERATED_MARKER = /auto-generated|@generated|code generated|do not edit/i;
const GENERATED_NAME = /(\.designer\.cs|\.g\.cs|\.g\.i\.cs|\.min\.js|\.generated\.[^./\\]+)$/i;

/** True for machine-written files (marker in the first 5 lines, or a generated-file name). */
export function isGeneratedFile(relPath: string, source: string): boolean {
  if (GENERATED_NAME.test(basename(relPath))) return true;
  let head = "";
  let pos = 0;
  for (let i = 0; i < 5 && pos < source.length; i++) {
    const nl = source.indexOf("\n", pos);
    const end = nl === -1 ? source.length : nl + 1;
    head += source.slice(pos, end);
    pos = end;
  }
  return GENERATED_MARKER.test(head);
}

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
  language: string,
  maxChars?: number
): CodeChunk[] {
  tryInitTreeSitter();
  if (isGeneratedFile(relPath, source)) {
    return slidingWindowChunks(projectId, sourceId, relPath, source, language, maxChars);
  }
  // Vue: extract <script> block, parse as TypeScript
  if (language === "vue") {
    const extracted = extractVueScript(source);
    if (extracted) {
      const parser = getParser("typescript");
      if (parser) {
        const chunks = astChunks(projectId, sourceId, relPath, extracted.code, "typescript", extracted.lineOffset, parser, maxChars);
        if (chunks.length > 0) return chunks;
      }
    }
    return slidingWindowChunks(projectId, sourceId, relPath, source, language, maxChars);
  }

  const langKey = LANGUAGE_TO_KEY[language];
  if (langKey) {
    const parser = getParser(language);
    if (parser) {
      const chunks = astChunks(projectId, sourceId, relPath, source, langKey, 0, parser, maxChars);
      if (chunks.length > 0) return chunks;
    }
  }

  return slidingWindowChunks(projectId, sourceId, relPath, source, language, maxChars);
}
