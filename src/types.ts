export interface EmbeddingConfig {
  base_url: string;
  model: string;
  dimensions: number;
  api_key_env: string; // env var NAME (never the key itself), e.g. "SCRYBE_CODE_EMBEDDING_API_KEY"
  // When absent or "api", uses the OpenAI-compatible HTTP client (existing behaviour).
  // When "local", uses the in-process @xenova/transformers pipeline; base_url and api_key_env are ignored.
  provider_type?: "api" | "local";
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
}

export interface Project {
  id: string;
  description: string;
  sources: Source[];
}

export interface CodeChunk {
  chunk_id: string;
  project_id: string;
  file_path: string; // relative, forward slashes
  content: string;
  start_line: number;
  end_line: number;
  language: string;
  symbol_name: string;
}

export interface SearchResult {
  chunk_id: string;
  score: number;
  project_id: string;
  source_id: string;
  file_path: string;
  start_line: number;
  end_line: number;
  language: string;
  symbol_name: string;
  content: string;
  branches: string[];  // master/main first, rest alphabetical; [] in compat mode
}

export interface KnowledgeChunk {
  chunk_id: string;
  project_id: string;
  source_id: string;
  source_path: string;   // e.g. "tickets/123", "https://docs.example.com/page"
  source_url: string;    // deep link back to the original
  source_type: string;   // "ticket" | "webpage" | "message"
  author: string;
  timestamp: string;     // ISO date string, empty string if unknown
  content: string;
}

export interface KnowledgeSearchResult {
  score: number;
  project_id: string;
  source_id: string;
  source_path: string;
  source_url: string;
  source_type: string;   // "ticket" | "webpage" | "message"
  author: string;
  timestamp: string;
  content: string;
}

export type IndexMode = "full" | "incremental";

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
