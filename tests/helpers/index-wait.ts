/**
 * Contract 5a — Synchronous index runner.
 * Wraps indexSource for use in tests. M-D2 will add waitForIdle(daemon) in
 * tests/helpers/daemon.ts as a parallel async primitive — NOT a rename of runIndex.
 */
import type { IndexResult } from "../../src/types.js";

export async function runIndex(
  projectId: string,
  sourceId: string,
  mode: "full" | "incremental",
  branch?: string
): Promise<IndexResult> {
  const { indexSource } = await import("../../src/indexer.js");
  return indexSource(projectId, sourceId, mode, branch ? { branch } : {});
}
