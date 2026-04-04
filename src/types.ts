export type SourceConfig =
  | { type: "code" }
  | { type: "ticket"; provider: string; base_url: string; project_id: string; token: string }
  | { type: "webpage"; sitemap_url: string; base_url?: string }
  | { type: "message"; provider: string; params: Record<string, string> };

export interface Project {
  id: string;
  root_path: string;
  languages: string[];
  description: string;
  source_config?: SourceConfig;
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
  file_path: string;
  start_line: number;
  end_line: number;
  language: string;
  symbol_name: string;
  content: string;
}

export interface KnowledgeChunk {
  chunk_id: string;
  project_id: string;
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
  chunks_indexed: number;
  files_scanned: number;
  files_reindexed: number;
  files_removed: number;
}

export interface JobState {
  job_id: string;
  project_id: string;
  mode: IndexMode;
  status: "running" | "done" | "cancelled" | "failed";
  phase: "scanning" | "embedding" | "done";
  files_scanned: number;
  chunks_indexed: number;
  started_at: number;
  finished_at: number | null;
  error: string | null;
}
