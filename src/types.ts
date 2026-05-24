export interface EmbeddingConfig {
  base_url: string;
  model: string;
  dimensions: number;
  api_key_env: string; // env var NAME (never the key itself), e.g. "SCRYBE_CODE_EMBEDDING_API_KEY"
  // When absent or "api", uses the OpenAI-compatible HTTP client (existing behaviour).
  // When "local", uses the in-process @xenova/transformers pipeline; base_url and api_key_env are ignored.
  provider_type?: "api" | "local";
  /**
   * Optional asymmetric prompt templates (Plan 77 / Plan 70).
   * Only used when provider_type === "local". When set, prepends `query` to query text
   * and `passage` to each passage text before passing to the embedding pipeline.
   */
  prompt_template?: { query: string; passage: string };
  /**
   * Per-preset maximum input token budget (Plan 77).
   * When set, derives a char cap of `max_input_tokens * 4` (heuristic).
   * The chunker uses this to prevent oversized chunks; the embedder applies it
   * as a final safety net via truncation.
   * Unset = legacy 32_000-char behavior.
   */
  max_input_tokens?: number;
}

export type SourceConfig =
  | { type: "code"; root_path: string; languages: string[] }
  | { type: "ticket"; provider: string; base_url: string; project_id: string; token: string }
  | { type: "webpage"; sitemap_url: string; base_url?: string }
  | { type: "message"; provider: string; params: Record<string, string> }
  | { type: string; [key: string]: unknown };

export interface Source {
  source_id: string; // user-defined, e.g. "code", "gitlab-issues"
  source_config: SourceConfig;
  embedding?: EmbeddingConfig; // absent = falls back to global env vars
  table_name?: string; // assigned at first index, immutable after
  last_indexed?: string;
  pinned_branches?: string[]; // code sources only; daemon indexes these in background
  /**
   * Schema version for the embedding vectors stored in this source's table.
   * Absent or 1 = legacy (pre-prefix, pre-token-cap — Plan 77 Slices 3+4 not yet applied).
   * 2 = current (prompt_template + max_input_tokens applied — Plan 77).
   * Stamped by the indexer on every successful full or incremental reindex.
   * Used by the daemon cold-start migration scan to detect sources that need reindex.
   */
  embedding_schema_version?: number;
}

export interface Project {
  id: string;
  description: string;
  sources: Source[];
}

// ─── Raw chunk shapes (emitted by plugins, no chunk_id yet) ──────────────────

/** Emitted by code plugins. No chunk_id — stampChunkId fills it before write. */
export interface RawCodeChunk {
  project_id: string;
  source_id: string;
  item_path: string;    // relative file path, forward slashes, e.g. "src/foo.ts"
  item_url: string;     // "" for code (no stable host-aware deep link today); ref-less when populated
  item_type: "code";
  content: string;
  start_line: number;
  end_line: number;
  language: string;
  symbol_name: string;
}

/** Emitted by knowledge plugins. No chunk_id — stampChunkId fills it before write. */
export interface RawKnowledgeChunk {
  project_id: string;
  source_id: string;
  item_path: string;    // provider slug, e.g. "issues/123", "issues/123#note_456"
  item_url: string;     // deep link back to the original (ref-less)
  item_type: string;    // "ticket" | "ticket_comment" | "webpage" | "message"
  author: string;
  timestamp: string;    // ISO date string, empty string if unknown
  content: string;
}

export type RawChunk = RawCodeChunk | RawKnowledgeChunk;
export type StampedChunk = CodeChunk | KnowledgeChunk;

// ─── Stamped chunk shapes (written to LanceDB, have chunk_id) ────────────────

export interface CodeChunk extends RawCodeChunk {
  chunk_id: string;
}

export interface KnowledgeChunk extends RawKnowledgeChunk {
  chunk_id: string;
}

export interface SearchResult {
  chunk_id: string;
  score: number;
  project_id: string;
  source_id: string;
  item_path: string;
  start_line: number;
  end_line: number;
  language: string;
  symbol_name: string;
  content: string;
  branches: string[];  // master/main first, rest alphabetical; [] in compat mode
}

export interface KnowledgeSearchResult {
  score: number;
  project_id: string;
  source_id: string;
  item_path: string;
  item_url: string;
  item_type: string;   // "ticket" | "ticket_comment" | "webpage" | "message"
  author: string;
  timestamp: string;
  content: string;
}

export type IndexMode = "full" | "incremental";

/**
 * Health flags that can appear in the `flags` array on a `ps --json` source row.
 * "bloat"           — table has accumulated too many Lance versions; run `scrybe gc`.
 * "needs_migration" — table was indexed with an older chunk-ID scheme; run `scrybe migrate`.
 * "corrupt"         — table health probe failed; see healthFlag for detail.
 * "model_mismatch"  — table was indexed with a different model than the current preset.
 */
export type SourceFlag = "bloat" | "needs_migration" | "corrupt" | "model_mismatch";

export interface IndexResult {
  status: "ok";
  project_id: string;
  source_id: string;
  /** Chunks that reached the embedder (prepared ≥ persisted). */
  chunks_prepared: number;
  /** Actual lance row delta: countTableRows(after) − countTableRows(before). */
  chunks_persisted: number;
  files_scanned: number;
  files_reindexed: number;
  files_removed: number;
}

export interface SourceTask {
  source_id: string;
  mode: IndexMode;
  status: "pending" | "running" | "done" | "failed" | "cancelled";
  phase: "scanning" | "embedding" | "done" | null;
  files_scanned: number;
  chunks_prepared: number;
  started_at: number | null;
  finished_at: number | null;
  error: string | null;
}

export interface JobState {
  job_id: string;
  project_id: string;
  /** Set on single-source reindex jobs */
  source_id?: string;
  mode: IndexMode;
  status: "queued" | "running" | "done" | "cancelled" | "failed";
  tasks: SourceTask[];
  started_at: number;
  finished_at: number | null;
  error: string | null;
  /** Set on reindex_all jobs — name of the project currently being indexed */
  current_project?: string;
}
