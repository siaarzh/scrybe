/**
 * Shared loader for @xenova/transformers.
 *
 * Sets env.cacheDir before any pipeline() call so model weights are pinned to a
 * durable location and survive reinstalls/npx cache wipes.
 *
 * Cache location precedence:
 *   1. SCRYBE_MODEL_CACHE_DIR  — explicit override (used by CI to share one
 *      cacheable path across temp DATA_DIRs; also lets advanced users relocate).
 *   2. ${DATA_DIR}/models      — default durable home.
 *
 * Safe to call multiple times — the cacheDir assignment is idempotent.
 * All three runtime import sites (local-embedder, reranker, validate-provider)
 * call this instead of doing their own dynamic import.
 */

import { join } from "path";
import { config } from "../config.js";

/**
 * Resolve the model cache root. Honors SCRYBE_MODEL_CACHE_DIR if set and
 * non-empty, else falls back to ${DATA_DIR}/models. Used by getTransformers(),
 * the doctor cache-path row, and the startup cache migration so all three agree.
 */
export function resolveModelCacheDir(): string {
  const override = process.env.SCRYBE_MODEL_CACHE_DIR;
  if (override && override.trim()) return override;
  return join(config.dataDir, "models");
}

/**
 * Dynamic-imports @xenova/transformers, pins env.cacheDir, and returns the
 * module. Call in place of `await import("@xenova/transformers")`.
 */
export async function getTransformers(): Promise<typeof import("@xenova/transformers")> {
  const mod = await import("@xenova/transformers");
  mod.env.cacheDir = resolveModelCacheDir();
  return mod;
}
