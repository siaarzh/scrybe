import { readFileSync, writeFileSync, existsSync } from "fs";
import { join } from "path";
import { config } from "./config.js";

const META_PATH = join(config.dataDir, "embedding-meta.json");

interface ProfileMeta {
  model: string;
  dimensions: number;
}

interface EmbeddingMeta {
  code: ProfileMeta;
  text?: ProfileMeta;
}

function readMeta(): EmbeddingMeta | null {
  if (!existsSync(META_PATH)) return null;
  try {
    const raw = JSON.parse(readFileSync(META_PATH, "utf8"));
    // Migrate legacy format { model, dimensions } → { code: { model, dimensions } }
    if ("model" in raw && "dimensions" in raw) {
      return { code: { model: raw.model as string, dimensions: raw.dimensions as number } };
    }
    return raw as EmbeddingMeta;
  } catch {
    return null;
  }
}

export function writeMeta(): void {
  const meta: EmbeddingMeta = {
    code: { model: config.embeddingModel, dimensions: config.embeddingDimensions },
    text: { model: config.textEmbeddingModel, dimensions: config.textEmbeddingDimensions },
  };
  writeFileSync(META_PATH, JSON.stringify(meta, null, 2));
}

/** Returns null if code embedding config matches stored, or an error string if it has changed. */
export function checkCodeMeta(): string | null {
  const meta = readMeta();
  if (!meta) return null;
  const codeChanged =
    meta.code.model !== config.embeddingModel ||
    meta.code.dimensions !== config.embeddingDimensions;
  if (!codeChanged) return null;
  return (
    `Code embedding configuration has changed since the last index ` +
    `(stored: ${meta.code.model} / ${meta.code.dimensions}d, ` +
    `current: ${config.embeddingModel} / ${config.embeddingDimensions}d). ` +
    `All indexed code data is incompatible with the new model. ` +
    `To recover: delete the LanceDB folder at ${config.dataDir}/lancedb, then reindex every project.`
  );
}

/** Returns null if text embedding config matches stored, or an error string if it has changed. */
export function checkTextMeta(): string | null {
  const meta = readMeta();
  if (!meta || !meta.text) return null;
  const textChanged =
    meta.text.model !== config.textEmbeddingModel ||
    meta.text.dimensions !== config.textEmbeddingDimensions;
  if (!textChanged) return null;
  return (
    `Text embedding configuration has changed since the last index ` +
    `(stored: ${meta.text.model} / ${meta.text.dimensions}d, ` +
    `current: ${config.textEmbeddingModel} / ${config.textEmbeddingDimensions}d). ` +
    `All indexed knowledge data is incompatible with the new model. ` +
    `To recover: delete the LanceDB folder at ${config.dataDir}/lancedb, then reindex every project.`
  );
}

/**
 * Returns null if stored embedding configs match current ones (or no meta exists yet).
 * Returns a human-readable error string if configs changed and existing indexed data is incompatible.
 */
export function checkMeta(): string | null {
  const meta = readMeta();
  if (!meta) return null; // first run — nothing indexed yet, no conflict

  const codeChanged =
    meta.code.model !== config.embeddingModel ||
    meta.code.dimensions !== config.embeddingDimensions;

  if (codeChanged) {
    return (
      `Code embedding configuration has changed since the last index ` +
      `(stored: ${meta.code.model} / ${meta.code.dimensions}d, ` +
      `current: ${config.embeddingModel} / ${config.embeddingDimensions}d). ` +
      `All indexed code data is incompatible with the new model. ` +
      `To recover: delete the LanceDB folder at ${config.dataDir}/lancedb, then reindex every project.`
    );
  }

  // Text profile mismatch is a warning but not a blocker for code search
  if (meta.text) {
    const textChanged =
      meta.text.model !== config.textEmbeddingModel ||
      meta.text.dimensions !== config.textEmbeddingDimensions;
    if (textChanged) {
      return (
        `Text embedding configuration has changed since the last index ` +
        `(stored: ${meta.text.model} / ${meta.text.dimensions}d, ` +
        `current: ${config.textEmbeddingModel} / ${config.textEmbeddingDimensions}d). ` +
        `All indexed knowledge data is incompatible with the new model. ` +
        `To recover: delete the LanceDB folder at ${config.dataDir}/lancedb, then reindex every project.`
      );
    }
  }

  return null;
}
