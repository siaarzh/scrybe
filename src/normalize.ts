/**
 * Normalize file content before chunking and hashing.
 * Called once at the "content enters the system" boundary in each plugin.
 *
 * Spec (Decision 3 — narrow, locked):
 *   - Strip leading UTF-8 BOM (U+FEFF)
 *   - Collapse \r\n and lone \r to \n
 *   Nothing else: trailing whitespace, Unicode NFC, tab expansion are intentionally
 *   out of scope to avoid breaking markdown hard-line-break syntax and similar.
 */
export function normalizeContent(s: string): string {
  if (s.charCodeAt(0) === 0xfeff) s = s.slice(1);
  return s.replace(/\r\n?/g, "\n");
}
