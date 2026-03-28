import { homedir } from "os";
import { join, dirname } from "path";
import { readFileSync, existsSync } from "fs";
import { fileURLToPath } from "url";

// Load .env (dev convenience; does NOT override existing env vars)
// Checks: cwd/.env first, then the repo root (dist/../.env) as fallback
(function loadDotEnv() {
  // __dirname equivalent in ESM
  const scriptDir = dirname(fileURLToPath(import.meta.url));
  const candidates = [
    join(process.cwd(), ".env"),
    join(scriptDir, "..", ".env"), // dist/../.env → repo root
  ];
  for (const p of candidates) {
    if (!existsSync(p)) continue;
    try {
      for (const line of readFileSync(p, "utf8").split("\n")) {
        const trimmed = line.trim();
        if (!trimmed || trimmed.startsWith("#")) continue;
        const eq = trimmed.indexOf("=");
        if (eq === -1) continue;
        const key = trimmed.slice(0, eq).trim();
        const val = trimmed.slice(eq + 1).trim();
        if (key && !(key in process.env)) process.env[key] = val;
      }
      break;
    } catch { /* ignore */ }
  }
})();

function getDataDir(): string {
  if (process.env.SCRYBE_DATA_DIR) return process.env.SCRYBE_DATA_DIR;
  const home = homedir();
  if (process.platform === "win32") {
    const localAppData = process.env.LOCALAPPDATA ?? join(home, "AppData", "Local");
    return join(localAppData, "scrybe", "scrybe");
  } else if (process.platform === "darwin") {
    return join(home, "Library", "Application Support", "scrybe");
  } else {
    const xdgData = process.env.XDG_DATA_HOME ?? join(home, ".local", "share");
    return join(xdgData, "scrybe");
  }
}

export const config = {
  dataDir: getDataDir(),

  // Embedding provider — any OpenAI-compatible endpoint
  embeddingApiKey:
    process.env.SCRYBE_EMBEDDING_API_KEY ??
    process.env.OPENAI_API_KEY ??
    process.env.MY_SCRYBE_OPENAI_TOKEN ??
    "",
  embeddingBaseUrl: process.env.SCRYBE_EMBEDDING_BASE_URL ?? undefined,
  embeddingModel:
    process.env.SCRYBE_EMBEDDING_MODEL ?? "text-embedding-3-small",
  embeddingDimensions: parseInt(
    process.env.SCRYBE_EMBEDDING_DIMENSIONS ?? "1536",
    10
  ),
  embedBatchSize: parseInt(process.env.SCRYBE_EMBED_BATCH_SIZE ?? "100", 10),

  // Chunker
  chunkSize: parseInt(process.env.SCRYBE_CHUNK_SIZE ?? "60", 10),
  chunkOverlap: parseInt(process.env.SCRYBE_CHUNK_OVERLAP ?? "10", 10),
} as const;
