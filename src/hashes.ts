import { createHash } from "crypto";
import { createReadStream, readFileSync, writeFileSync, mkdirSync, existsSync, unlinkSync } from "fs";
import { join } from "path";
import { config } from "./config.js";

const HASHES_DIR = join(config.dataDir, "hashes");

function hashesPath(projectId: string, sourceId: string): string {
  return join(HASHES_DIR, `${projectId}__${sourceId}.json`);
}

export function loadHashes(projectId: string, sourceId: string): Record<string, string> {
  const p = hashesPath(projectId, sourceId);
  if (!existsSync(p)) return {};
  try {
    return JSON.parse(readFileSync(p, "utf8")) as Record<string, string>;
  } catch {
    return {};
  }
}

export function saveHashes(
  projectId: string,
  sourceId: string,
  hashes: Record<string, string>
): void {
  mkdirSync(HASHES_DIR, { recursive: true });
  writeFileSync(hashesPath(projectId, sourceId), JSON.stringify(hashes, null, 2), "utf8");
}

export function deleteHashes(projectId: string, sourceId: string): void {
  const p = hashesPath(projectId, sourceId);
  if (existsSync(p)) unlinkSync(p);
}

export function saveHash(projectId: string, sourceId: string, key: string, value: string): void {
  const hashes = loadHashes(projectId, sourceId);
  hashes[key] = value;
  saveHashes(projectId, sourceId, hashes);
}

export function removeHash(projectId: string, sourceId: string, key: string): void {
  const hashes = loadHashes(projectId, sourceId);
  delete hashes[key];
  saveHashes(projectId, sourceId, hashes);
}

// Inlined to avoid any circular dep: branches.ts → registry.ts would close a cycle if imported here.
function slugifyBranch(branch: string): string {
  if (branch === "*") return "_all_";
  return branch.replace(/\//g, "__");
}

function branchHashesPath(projectId: string, sourceId: string, branch: string): string {
  return join(HASHES_DIR, `${projectId}__${sourceId}__${slugifyBranch(branch)}.json`);
}

export function loadBranchHashes(
  projectId: string,
  sourceId: string,
  branch: string
): Record<string, string> {
  const p = branchHashesPath(projectId, sourceId, branch);
  if (!existsSync(p)) return {};
  try {
    return JSON.parse(readFileSync(p, "utf8")) as Record<string, string>;
  } catch {
    return {};
  }
}

export function saveBranchHashes(
  projectId: string,
  sourceId: string,
  branch: string,
  hashes: Record<string, string>
): void {
  mkdirSync(HASHES_DIR, { recursive: true });
  writeFileSync(branchHashesPath(projectId, sourceId, branch), JSON.stringify(hashes, null, 2), "utf8");
}

export function deleteBranchHashes(projectId: string, sourceId: string, branch: string): void {
  const p = branchHashesPath(projectId, sourceId, branch);
  if (existsSync(p)) unlinkSync(p);
}

export function saveBranchHash(
  projectId: string,
  sourceId: string,
  branch: string,
  key: string,
  value: string
): void {
  const hashes = loadBranchHashes(projectId, sourceId, branch);
  hashes[key] = value;
  saveBranchHashes(projectId, sourceId, branch, hashes);
}

export function removeBranchHash(
  projectId: string,
  sourceId: string,
  branch: string,
  key: string
): void {
  const hashes = loadBranchHashes(projectId, sourceId, branch);
  delete hashes[key];
  saveBranchHashes(projectId, sourceId, branch, hashes);
}

export function hashFile(filePath: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const hash = createHash("sha256");
    const stream = createReadStream(filePath);
    stream.on("data", (chunk) => hash.update(chunk));
    stream.on("end", () => resolve(hash.digest("hex")));
    stream.on("error", reject);
  });
}
