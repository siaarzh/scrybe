/**
 * Contract 7 — Embedder client cache reset.
 * Purges the _clients map in src/embedder.ts between tests.
 * With vi.resetModules() the cache is naturally cleared, but this export
 * is preserved for downstream milestones that may not use resetModules().
 */
export async function resetEmbedderClientCache(): Promise<void> {
  const { resetEmbedderClientCache: reset } = await import("../../src/embedder.js");
  reset();
}
