/**
 * Scenario harness — snapshot redaction serializer.
 * Normalizes dynamic values so snapshots are stable across runs and machines.
 *
 * Register in vitest.config.ts via `snapshotSerializers`.
 */

/** Redact dynamic values from a string for stable snapshot comparison. */
export function redact(text: string): string {
  return text
    // Normalize Windows path separators first
    .replace(/\\/g, "/")
    // Scenario temp dirs (DATA_DIR, repo paths)
    .replace(/\/[^\s"']*scrybe-scenario-[A-Za-z0-9]+[^\s"']*/g, "<TMPDIR>")
    .replace(/\/[^\s"']*scrybe-repo-[A-Za-z0-9]+[^\s"']*/g, "<REPODIR>")
    // Windows-style temp paths after normalization
    .replace(/[A-Za-z]:[^\s"']*scrybe-scenario-[A-Za-z0-9]+[^\s"']*/g, "<TMPDIR>")
    .replace(/[A-Za-z]:[^\s"']*scrybe-repo-[A-Za-z0-9]+[^\s"']*/g, "<REPODIR>")
    // Timestamps — ISO 8601
    .replace(/\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?Z/g, "<TIMESTAMP>")
    // Relative time (from fmtRelative)
    .replace(/\d+[dhm] ago/g, "<AGO>")
    .replace(/just now/g, "<AGO>")
    // Durations
    .replace(/\b\d+\.\d+s\b|\b\d+ms\b/g, "<DURATION>")
    .replace(/\b\d+h \d+m\b|\b\d+m \d+s\b/g, "<DURATION>")
    // File sizes
    .replace(/\b\d+(?:\.\d+)? (GB|MB|KB|B)\b/g, "<SIZE>")
    // PIDs
    .replace(/\bPID \d+\b/g, "PID <PID>")
    .replace(/"pid": \d+/g, '"pid": <PID>')
    // Ports
    .replace(/\bport \d{4,5}\b/gi, "port <PORT>")
    .replace(/"port": \d+/g, '"port": <PORT>')
    // Lance version counts (e.g. "14 versions" in ps output)
    .replace(/\b\d+ versions\b/g, "<VCOUNT> versions")
    // Chunk counts that vary by run
    .replace(/\b\d+ chunks\b/g, "<N> chunks")
    // Version strings (vX.Y.Z)
    .replace(/v\d+\.\d+\.\d+/g, "v<VERSION>");
}

/** Vitest snapshot serializer — apply redaction to string snapshots. */
export const redactSerializer = {
  test(val: unknown): val is string {
    return typeof val === "string";
  },
  print(val: string): string {
    return redact(val);
  },
};
