/**
 * Startup sweep for leaked `_ephemeral/` branch labels (Plan 99 Slice 5).
 *
 * `index_ephemeral` (Slice 3) writes labels under the `_ephemeral/` prefix for
 * short-lived MR/review indexing, and `drop_ephemeral` (Slice 4) is the normal
 * teardown path. But a crashed or forgotten review leaves the label's
 * branch_tags/branch_state/hashes — and its unique chunks — behind forever;
 * nothing else ever cleans them up. This module is the backstop.
 *
 * Runs ONCE at daemon cold start (see the call site in main.ts) — never on a
 * timer, never mid-run. It reuses the same deleteBranch + source-scoped gc
 * shape as `drop_ephemeral` itself (mirrors wipeSource's in-process
 * convention), but calls `runGcJobHandler` directly rather than going through
 * `dropEphemeralTool.handler`'s daemon-routing path: at this point in startup
 * the daemon's own pidfile/HTTP listener are not necessarily up yet, so
 * routing the sweep's gc through `ensureRunning()`/HTTP would risk the daemon
 * calling out to itself before it's ready.
 */
import { listEphemeralBranches, deleteBranch } from "../branch-state.js";
import { runGcJobHandler } from "./gc-handler.js";
import type { Project } from "../types.js";

export interface EphemeralSweepEntry {
  projectId: string;
  sourceId: string;
  label: string;
  orphansDeleted: number;
  bytesFreed: number;
}

/**
 * Enumerate and reclaim every leaked `_ephemeral/*` label across the given
 * projects. Non-fatal at every layer: a failure on one label (or one
 * project/source) must not abort the sweep or the daemon's startup.
 */
export async function sweepEphemeralBranches(projects: Project[]): Promise<EphemeralSweepEntry[]> {
  const swept: EphemeralSweepEntry[] = [];

  for (const project of projects) {
    for (const source of project.sources) {
      if (source.source_config.type !== "code") continue; // ephemeral labels are branches; only code sources have them

      let labels: string[];
      try {
        labels = listEphemeralBranches(project.id, source.source_id);
      } catch {
        continue;
      }

      for (const label of labels) {
        try {
          deleteBranch(project.id, source.source_id, label);
          const gcResult = await runGcJobHandler({
            projectId: project.id,
            sourceId: source.source_id,
            mode: "purge",
          });
          swept.push({
            projectId: project.id,
            sourceId: source.source_id,
            label,
            orphansDeleted: gcResult.orphans_deleted,
            bytesFreed: gcResult.bytes_freed,
          });
        } catch {
          // non-fatal — one bad label must not block the rest of the sweep
        }
      }
    }
  }

  return swept;
}
