/**
 * Contract 13 — Sync git helpers for branch-aware tests.
 * All functions run `git -C <handle.path> <cmd>` via execSync.
 * No imports from src/ — strictly subprocess wrappers.
 */
import { execSync } from "child_process";
import { writeFileSync, unlinkSync, mkdirSync, existsSync } from "fs";
import { join, dirname } from "path";
import type { FixtureHandle } from "./fixtures.js";

function git(handle: FixtureHandle, args: string): void {
  execSync(`git -C "${handle.path}" ${args}`, { stdio: "ignore" });
}

/** Creates a new branch, optionally from a specific source branch. */
export function createBranch(handle: FixtureHandle, branch: string, fromBranch?: string): void {
  const from = fromBranch ? ` ${fromBranch}` : "";
  git(handle, `checkout -b "${branch}"${from}`);
}

/** Switches to an existing branch. */
export function switchBranch(handle: FixtureHandle, branch: string): void {
  try {
    git(handle, `checkout "${branch}"`);
  } catch {
    // DWIM checkout unreliable on Windows for slash-path branches — create explicit tracking branch
    git(handle, `checkout -b "${branch}" "origin/${branch}"`);
  }
}

/** Writes (or overwrites) a file and commits it. */
export function commitFile(
  handle: FixtureHandle,
  relPath: string,
  content: string,
  message = `update ${relPath}`
): void {
  const absPath = join(handle.path, relPath);
  mkdirSync(dirname(absPath), { recursive: true });
  writeFileSync(absPath, content, "utf8");
  git(handle, `add "${relPath}"`);
  git(handle, `commit -m "${message}"`);
}

/** Deletes a file and commits the removal. */
export function deleteFile(
  handle: FixtureHandle,
  relPath: string,
  message = `delete ${relPath}`
): void {
  const absPath = join(handle.path, relPath);
  if (existsSync(absPath)) unlinkSync(absPath);
  git(handle, `add -A`);
  git(handle, `commit -m "${message}"`);
}

/** Renames a file and commits the rename. */
export function renameFile(
  handle: FixtureHandle,
  from: string,
  to: string,
  message = `rename ${from} to ${to}`
): void {
  git(handle, `mv "${from}" "${to}"`);
  git(handle, `commit -m "${message}"`);
}

/** Returns the current branch name (HEAD). */
export function getCurrentBranch(handle: FixtureHandle): string {
  return execSync(`git -C "${handle.path}" rev-parse --abbrev-ref HEAD`, {
    encoding: "utf8",
  }).trim();
}
