import type { StampedChunk, Project, Source } from "../types.js";

export type AnyChunk = StampedChunk;

export interface SourcePlugin {
  /** Matches SourceConfig.type — used by the registry to route projects */
  readonly type: string;
  /** Which embedding profile to use for this source's vectors */
  readonly embeddingProfile: "code" | "text";
  /**
   * Returns a path/key → content-hash map for all indexable sources.
   * Used during the incremental diff phase to decide what changed.
   */
  scanSources(project: Project, source: Source, cursor?: string | null): Promise<Record<string, string>>;
  /**
   * Yields chunks for the given set of changed source keys.
   * Each key matches one returned by scanSources().
   */
  fetchChunks(project: Project, source: Source, changed: Set<string>): AsyncGenerator<AnyChunk>;
}
