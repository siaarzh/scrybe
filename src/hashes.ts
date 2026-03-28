import { createHash } from "crypto";
import { createReadStream, readFileSync, writeFileSync, mkdirSync, existsSync, unlinkSync } from "fs";
import { join } from "path";
import { config } from "./config.js";

const HASHES_DIR = join(config.dataDir, "hashes");

function hashesPath(projectId: string): string {
  return join(HASHES_DIR, `${projectId}.json`);
}

export function loadHashes(projectId: string): Record<string, string> {
  const p = hashesPath(projectId);
  if (!existsSync(p)) return {};
  try {
    return JSON.parse(readFileSync(p, "utf8")) as Record<string, string>;
  } catch {
    return {};
  }
}

export function saveHashes(
  projectId: string,
  hashes: Record<string, string>
): void {
  mkdirSync(HASHES_DIR, { recursive: true });
  writeFileSync(hashesPath(projectId), JSON.stringify(hashes, null, 2), "utf8");
}

export function deleteHashes(projectId: string): void {
  const p = hashesPath(projectId);
  if (existsSync(p)) unlinkSync(p);
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
