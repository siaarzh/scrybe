// Host allowlist + Origin rejection for the daemon's HTTP server (#102).

const BUILTIN_ALLOWED_HOSTS = ["localhost", "127.0.0.1"];

// Entries that can never equal a parsed hostname; each is warned about once.
const INVALID_HOST_ENTRY_RE = /[:[\]/]|[^\x00-\x7f]/;
const warnedInvalidEntries = new Set<string>();

function readAllowedHosts(): Set<string> {
  const extra = (process.env["SCRYBE_DAEMON_ALLOWED_HOSTS"] ?? "")
    .split(",")
    .map((h) => h.trim().toLowerCase())
    .filter(Boolean);

  const valid: string[] = [];
  for (const entry of extra) {
    if (INVALID_HOST_ENTRY_RE.test(entry)) {
      if (!warnedInvalidEntries.has(entry)) {
        warnedInvalidEntries.add(entry);
        console.warn(`[host-gate] SCRYBE_DAEMON_ALLOWED_HOSTS entry '${entry}' is not a plain hostname (IPv6 literals and ports are not supported); ignoring it`);
      }
    } else {
      valid.push(entry);
    }
  }
  return new Set([...BUILTIN_ALLOWED_HOSTS, ...valid]);
}

/** Extracts the bare hostname from a `Host` header value, dropping any port. */
export function parseHostHeader(value: string | undefined): string | null {
  if (!value) return null;
  const trimmed = value.trim();
  if (!trimmed) return null;
  if (trimmed.startsWith("[")) {
    const end = trimmed.indexOf("]");
    if (end === -1) return null; // malformed bracketed literal
    return trimmed.slice(1, end).toLowerCase();
  }
  const colon = trimmed.lastIndexOf(":");
  if (colon !== -1 && /^\d+$/.test(trimmed.slice(colon + 1))) {
    return trimmed.slice(0, colon).toLowerCase();
  }
  return trimmed.toLowerCase();
}

export type HostGateReason = "missing-host" | "foreign-host" | "origin-present";

export interface HostGateResult {
  allowed: boolean;
  reason?: HostGateReason;
}

/** Any Origin, even "null" or "", is refused: only browsers send one, and no scrybe client does. */
export function checkHostAndOrigin(hostHeader: string | undefined, originHeader: string | undefined): HostGateResult {
  const allowed = readAllowedHosts();

  const host = parseHostHeader(hostHeader);
  if (!host) return { allowed: false, reason: "missing-host" };
  if (!allowed.has(host)) return { allowed: false, reason: "foreign-host" };

  if (originHeader !== undefined) return { allowed: false, reason: "origin-present" };

  return { allowed: true };
}
