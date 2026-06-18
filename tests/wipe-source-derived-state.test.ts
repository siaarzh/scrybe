/**
 * Unit test for the derived-state leak on source removal.
 *
 * Before the fix:
 *   wipeSource cleared branch_tags + branch_state + hash files, but left the
 *   fetch cursor and embed-batch tuning entries behind. A removed ticket source
 *   re-added under the same id inherited a stale `updated_after` cursor → the
 *   incremental fetch asked GitHub/GitLab for issues "since last time" → nothing
 *   came back → the source indexed silently to zero rows.
 *
 * After the fix:
 *   wipeSource also calls deleteCursor + deleteEntriesForSource, so a re-added
 *   source starts from a clean cursor (full backfill) and clean batch tuning.
 *
 * These are exercised directly (no fixture / network) — the cursor + batch
 * stores are plain files under DATA_DIR keyed by (project, source).
 */
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

describe("wipeSource clears all per-source derived state", () => {
  let dir: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "scrybe-wipe-derived-"));
    process.env["SCRYBE_DATA_DIR"] = dir;
  });

  afterEach(() => {
    delete process.env["SCRYBE_DATA_DIR"];
    try { rmSync(dir, { recursive: true, force: true }); } catch { /* ignore */ }
  });

  it("deletes the fetch cursor for the removed source", async () => {
    const { saveCursor, loadCursor } = await import("../src/cursors.js");
    const { wipeSource } = await import("../src/branch-state.js");

    saveCursor("proj-a", "gitlab-issues", "2026-06-07T20:13:27.079Z");
    saveCursor("proj-a", "code", "2026-06-07T10:00:00.000Z"); // sibling, must survive
    expect(loadCursor("proj-a", "gitlab-issues")).not.toBeNull();

    wipeSource("proj-a", "gitlab-issues");

    // Removed source's cursor is gone → a re-add backfills from scratch.
    expect(loadCursor("proj-a", "gitlab-issues")).toBeNull();
    // Sibling source on the same project is untouched.
    expect(loadCursor("proj-a", "code")).toBe("2026-06-07T10:00:00.000Z");
  });

  it("deletes embed-batch entries for the removed source regardless of provider/model", async () => {
    const { writeEntry, readEntry } = await import("../src/embed-batch-state.js");
    const { wipeSource } = await import("../src/branch-state.js");

    // Two entries for the doomed source (provider changed over its lifetime).
    const k1 = "proj-a:gitlab-issues:https://api.voyageai.com/v1:voyage-code-3";
    const k2 = "proj-a:gitlab-issues:local:e5-small";
    // Entry for a sibling source that must survive.
    const kSurvivor = "proj-a:code:https://api.voyageai.com/v1:voyage-code-3";
    writeEntry(k1, { lastSuccessful: 64, maxFailed: 128 });
    writeEntry(k2, { lastSuccessful: 32, maxFailed: 64 });
    writeEntry(kSurvivor, { lastSuccessful: 96, maxFailed: 192 });

    wipeSource("proj-a", "gitlab-issues");

    expect(readEntry(k1)).toBeNull();
    expect(readEntry(k2)).toBeNull();
    expect(readEntry(kSurvivor)).not.toBeNull();
  });

  it("is a no-op when no derived state exists (idempotent, no throw)", async () => {
    const { wipeSource } = await import("../src/branch-state.js");
    expect(() => wipeSource("never-existed", "nope")).not.toThrow();
  });
});
