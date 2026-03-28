import { readFileSync, writeFileSync, existsSync } from "fs";
import { join } from "path";
import { config } from "./config.js";

const META_PATH = join(config.dataDir, "embedding-meta.json");

interface EmbeddingMeta {
  model: string;
  dimensions: number;
}

function readMeta(): EmbeddingMeta | null {
  if (!existsSync(META_PATH)) return null;
  try {
    return JSON.parse(readFileSync(META_PATH, "utf8")) as EmbeddingMeta;
  } catch {
    return null;
  }
}

export function writeMeta(): void {
  writeFileSync(
    META_PATH,
    JSON.stringify(
      { model: config.embeddingModel, dimensions: config.embeddingDimensions },
      null,
      2
    )
  );
}

/**
 * Returns null if the stored embedding config matches the current one (or no
 * meta exists yet). Returns a human-readable error string if the config has
 * changed and existing indexed data is incompatible.
 */
export function checkMeta(): string | null {
  const meta = readMeta();
  if (!meta) return null; // first run — nothing indexed yet, no conflict

  if (
    meta.model !== config.embeddingModel ||
    meta.dimensions !== config.embeddingDimensions
  ) {
    return (
      `Embedding configuration has changed since the last index ` +
      `(stored: ${meta.model} / ${meta.dimensions}d, ` +
      `current: ${config.embeddingModel} / ${config.embeddingDimensions}d). ` +
      `All indexed data is incompatible with the new model. ` +
      `Run reindex_project with mode="full" for every registered project to rebuild the index, ` +
      `then search and incremental reindex will work again.`
    );
  }
  return null;
}
