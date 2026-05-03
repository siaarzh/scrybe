/**
 * Private ignore rules — per-source, stored in DATA_DIR/ignores/<project_id>/<source_id>.gitignore
 *
 * These rules live outside the repo and are never committed. They augment the
 * committed .scrybeignore with personal or machine-local exclusions.
 */
import { existsSync, readFileSync, writeFileSync, mkdirSync, unlinkSync } from "fs";
import { join } from "path";
import { gitExec } from "./util/git-exec.js";
import { config } from "./config.js";

// ─── Path helpers ─────────────────────────────────────────────────────────────

export function getPrivateIgnorePath(projectId: string, sourceId: string): string {
  return join(config.dataDir, "ignores", projectId, `${sourceId}.gitignore`);
}

// ─── Editor template for new files ───────────────────────────────────────────

export function buildTemplate(projectId: string, sourceId: string): string {
  return [
    `# Private ignore rules for ${projectId}/${sourceId}`,
    "#",
    "# Applied additively on top of:",
    "#   - built-in skip rules (node_modules, .git, etc.)",
    "#   - .gitignore (already excluded from indexing)",
    "#   - committed .scrybeignore (if present)",
    "#",
    "# Same syntax as .gitignore — one pattern per line:",
    "#   vendor/                  # exclude a directory",
    "#   *.generated.ts           # exclude by glob",
    "#   !docs/important.md       # override .gitignore / .scrybeignore",
    "#",
    "# This file lives in scrybe's DATA_DIR and is never committed.",
    "",
  ].join("\n");
}

// ─── Load / save ──────────────────────────────────────────────────────────────

/**
 * Load the private ignore content for a (project, source) pair.
 * Returns null if the file does not exist.
 */
export function loadPrivateIgnore(projectId: string, sourceId: string): string | null {
  const filePath = getPrivateIgnorePath(projectId, sourceId);
  if (!existsSync(filePath)) return null;
  try {
    return readFileSync(filePath, "utf8");
  } catch {
    return null;
  }
}

/**
 * Write (or delete) the private ignore file for a (project, source) pair.
 * Passing empty string or null deletes the file (or does nothing if it doesn't exist).
 */
export function savePrivateIgnore(
  projectId: string,
  sourceId: string,
  content: string | null
): void {
  const filePath = getPrivateIgnorePath(projectId, sourceId);
  if (!content) {
    // Delete if exists
    if (existsSync(filePath)) {
      unlinkSync(filePath);
    }
    return;
  }
  const dir = join(config.dataDir, "ignores", projectId);
  mkdirSync(dir, { recursive: true });
  writeFileSync(filePath, content, "utf8");
}

/**
 * Create the private ignore file with the header template if it doesn't exist.
 * Returns the file path (always, regardless of whether it was created).
 */
export function ensurePrivateIgnoreFile(projectId: string, sourceId: string): string {
  const filePath = getPrivateIgnorePath(projectId, sourceId);
  if (!existsSync(filePath)) {
    const dir = join(config.dataDir, "ignores", projectId);
    mkdirSync(dir, { recursive: true });
    writeFileSync(filePath, buildTemplate(projectId, sourceId), "utf8");
  }
  return filePath;
}

// ─── Content analysis ─────────────────────────────────────────────────────────

/**
 * Returns true if the content is "empty" for purposes of the "no rules" check:
 *  - null (file missing)
 *  - empty string
 *  - contains only comment lines (# ...) and/or whitespace
 */
export function isMissingOrEmpty(content: string | null): boolean {
  if (content === null) return true;
  return content.split(/\r?\n/).every((line) => {
    const t = line.trim();
    return t === "" || t.startsWith("#");
  });
}

/**
 * Count non-comment non-whitespace lines (rules) in a private ignore file.
 */
export function countRules(content: string | null): number {
  if (content === null) return 0;
  return content.split(/\r?\n/).filter((line) => {
    const t = line.trim();
    return t !== "" && !t.startsWith("#");
  }).length;
}

// ─── Pinned-branch coverage check ────────────────────────────────────────────

/**
 * Read the committed .scrybeignore from a specific git branch (without checkout).
 * Returns null if the file doesn't exist on that branch or git fails.
 */
function gitShowFile(rootPath: string, branch: string, relPath: string): string | null {
  return gitExec(["show", `${branch}:${relPath}`], { cwd: rootPath, trim: false });
}

export interface IgnoreCoverageResult {
  hasCoverage: boolean;
  hasCommittedIgnore: boolean;
  hasPrivateIgnore: boolean;
  /**
   * Human-readable warning message if !hasCoverage.
   * null when hasCoverage = true.
   */
  message: string | null;
}

/**
 * Check whether a pinned branch has any ignore coverage (committed .scrybeignore
 * or non-empty private ignore). If neither is present, emit a warning.
 *
 * @param rootPath  Filesystem path to the git repo (used for git show)
 * @param branch    Branch name being pinned
 * @param projectId Scrybe project ID
 * @param sourceId  Scrybe source ID
 */
export function checkIgnoreCoverage(
  rootPath: string,
  branch: string,
  projectId: string,
  sourceId: string
): IgnoreCoverageResult {
  const hasCommittedIgnore = !!gitShowFile(rootPath, branch, ".scrybeignore");
  const privateContent = loadPrivateIgnore(projectId, sourceId);
  const hasPrivateIgnore = !isMissingOrEmpty(privateContent);

  if (hasCommittedIgnore || hasPrivateIgnore) {
    return { hasCoverage: true, hasCommittedIgnore, hasPrivateIgnore, message: null };
  }

  const message = [
    `warning: branch '${branch}' has no .scrybeignore and source '${projectId}/${sourceId}' has no private ignore.`,
    `         indexing will use built-in skip rules + .gitignore only.`,
    `         consider running: scrybe ignore   (to set source-level rules)`,
    `                       or: add .scrybeignore to the ${branch} branch`,
  ].join("\n");

  return { hasCoverage: false, hasCommittedIgnore, hasPrivateIgnore, message };
}
