import { readdirSync, statSync, existsSync } from "fs";
import { join, resolve } from "path";
import { homedir } from "os";
import { listProjects } from "../registry.js";
import { sniffLanguage } from "./language-sniff.js";

export interface DiscoveredRepo {
  path: string;
  isGitRepo: boolean;
  alreadyRegistered: boolean;
  primaryLanguage?: string;
  fileCount: number;
}

export interface DiscoveryOptions {
  extraRoots?: string[];
  maxDepth?: number;
  maxDirs?: number;
  timeoutMs?: number;
  ignoreRegistered?: boolean;
}

export type DiscoveryLimit = "depth" | "dirs" | "time" | null;

export interface DiscoveryResult {
  repos: DiscoveredRepo[];
  hitLimit: DiscoveryLimit;
  scannedRoots: string[];
}

// Returns parent directories of recently-opened VS Code workspaces.
// Hardcoded candidates (~/repos, ~/code, etc.) removed — the wizard prompts the user explicitly.
export function defaultRoots(home?: string): string[] {
  const h = home ?? homedir();
  return [...new Set(getVSCodeWorkspacePaths(h))].filter(existsSync);
}

function getVSCodeWorkspacePaths(home: string): string[] {
  // Try to read VSCode recently-opened from globalStorage
  const storageCandidates = [
    join(home, "AppData", "Roaming", "Code", "User", "globalStorage", "storage.json"), // Windows
    join(home, "Library", "Application Support", "Code", "User", "globalStorage", "storage.json"), // macOS
    join(home, ".config", "Code", "User", "globalStorage", "storage.json"), // Linux
  ];
  const paths: string[] = [];
  for (const storagePath of storageCandidates) {
    if (!existsSync(storagePath)) continue;
    try {
      const raw = JSON.parse(require("fs").readFileSync(storagePath, "utf8"));
      const openedFolders: string[] = raw?.["openedPathsList"]?.["entries"]
        ?.map((e: any) => e?.folderUri ?? e?.fileUri)
        .filter(Boolean)
        .map((uri: string) => uri.replace(/^file:\/\/\//, "").replace(/^file:\/\//, ""))
        ?? [];
      for (const p of openedFolders) {
        const resolved = resolve(decodeURIComponent(p));
        if (existsSync(resolved)) {
          const parent = resolve(join(resolved, ".."));
          if (!paths.includes(parent)) paths.push(parent);
        }
      }
    } catch { /* ignore parse errors */ }
    break;
  }
  return paths;
}

const SKIP_DIRS = new Set([
  ".git", "node_modules", "dist", "build", ".next", ".nuxt", "target",
  "__pycache__", ".venv", "venv", "vendor",
]);

export async function discoverRepos(opts?: DiscoveryOptions): Promise<DiscoveryResult> {
  const maxDepth = opts?.maxDepth ?? 3;
  const maxDirs  = opts?.maxDirs  ?? 500;
  const timeoutMs = opts?.timeoutMs ?? 5_000;

  const roots = [...(opts?.extraRoots?.map((p) => resolve(p)) ?? [])];

  const seenPaths = new Set<string>();
  const repos: DiscoveredRepo[] = [];
  let dirsScanned = 0;
  let hitLimit: DiscoveryLimit = null;
  const deadline = Date.now() + timeoutMs;
  const scannedRoots: string[] = [];

  // Build registered root_path set once
  const registeredPaths = new Set(
    listProjects()
      .flatMap((p) => p.sources)
      .filter((s) => s.source_config.type === "code")
      .map((s) => resolve((s.source_config as any).root_path as string))
  );

  function walk(dir: string, depth: number): void {
    if (Date.now() > deadline) { hitLimit = "time"; return; }
    if (dirsScanned >= maxDirs) { hitLimit = "dirs"; return; }
    if (depth > maxDepth) return;

    dirsScanned++;
    let entries: string[];
    try { entries = readdirSync(dir); } catch { return; }

    const isGitRepo = entries.includes(".git");

    if (isGitRepo && !seenPaths.has(dir)) {
      seenPaths.add(dir);
      const absPath = resolve(dir);
      const alreadyRegistered = registeredPaths.has(absPath);

      if (!opts?.ignoreRegistered || !alreadyRegistered) {
        const { language, histogram } = sniffLanguage(dir, 500);
        const fileCount = Object.values(histogram).reduce((a, b) => a + b, 0);
        repos.push({ path: absPath, isGitRepo: true, alreadyRegistered, primaryLanguage: language, fileCount });
      }
      // Don't recurse into a git repo's subdirectories
      return;
    }

    if (depth < maxDepth) {
      for (const entry of entries) {
        if (SKIP_DIRS.has(entry) || entry.startsWith(".")) continue;
        const full = join(dir, entry);
        let st;
        try { st = statSync(full); } catch { continue; }
        if (st.isDirectory()) {
          walk(full, depth + 1);
          if (hitLimit) return;
        }
      }
    }
  }

  for (const root of roots) {
    if (!existsSync(root)) continue;
    scannedRoots.push(root);
    walk(root, 0);
    if (hitLimit) break;
  }

  return { repos, hitLimit, scannedRoots };
}
