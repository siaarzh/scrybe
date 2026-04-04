export interface Project {
  id: string;
  root_path: string;
  languages: string[];
  description: string;
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
