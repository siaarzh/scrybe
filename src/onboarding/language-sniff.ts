import { readdirSync, statSync } from "fs";
import { join, extname } from "path";

const EXT_TO_LANG: Record<string, string> = {
  ts: "typescript", tsx: "typescript",
  js: "javascript", jsx: "javascript", mjs: "javascript", cjs: "javascript",
  py: "python",
  cs: "csharp",
  go: "go",
  rs: "rust",
  java: "java",
  rb: "ruby",
  cpp: "cpp", cc: "cpp", cxx: "cpp",
  c: "c", h: "c",
  vue: "vue",
  svelte: "svelte",
  kt: "kotlin",
  swift: "swift",
  php: "php",
};

const SKIP_DIRS = new Set([
  "node_modules", ".git", "dist", "build", "out", ".next", ".nuxt",
  "vendor", "target", "bin", "obj", ".cache", "__pycache__",
]);

export interface SniffResult {
  language: string | undefined;
  histogram: Record<string, number>;
}

export function sniffLanguage(rootPath: string, maxFiles = 2000): SniffResult {
  const counts: Record<string, number> = {};
  let seen = 0;

  function walk(dir: string, depth: number): void {
    if (seen >= maxFiles || depth > 4) return;
    let entries: string[];
    try { entries = readdirSync(dir); } catch { return; }
    for (const entry of entries) {
      if (seen >= maxFiles) return;
      if (SKIP_DIRS.has(entry)) continue;
      const full = join(dir, entry);
      let st;
      try { st = statSync(full); } catch { continue; }
      if (st.isDirectory()) {
        walk(full, depth + 1);
      } else {
        const ext = extname(entry).slice(1).toLowerCase();
        const lang = EXT_TO_LANG[ext];
        if (lang) {
          counts[lang] = (counts[lang] ?? 0) + 1;
          seen++;
        }
      }
    }
  }

  walk(rootPath, 0);

  const top = Object.entries(counts).sort((a, b) => b[1] - a[1]);
  const language = top.length === 0 ? undefined
    : top.length === 1 || top[0][1] > top[1][1] * 1.5
      ? top[0][0]
      : "mixed";

  return { language, histogram: counts };
}

export { EXT_TO_LANG };
