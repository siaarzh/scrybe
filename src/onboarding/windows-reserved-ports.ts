/**
 * Windows reserved-port-range detection for `scrybe doctor`.
 *
 * Hyper-V and WSL reserve blocks of TCP ports at boot (visible via
 * `netsh interface ipv4 show excludedportrange protocol=tcp`). A port that
 * falls inside a reserved block returns EACCES on bind. The daemon already
 * falls through to another port when that happens (see http-server.ts), but
 * `scrybe doctor` gave no hint that this was happening — see GitHub issue
 * #100. This module supplies that hint.
 *
 * Only runs on Windows (process.platform === "win32").
 */

import { execFileSync } from "child_process";

const NETSH_TIMEOUT_MS = 2_000;

export interface PortRange {
  start: number;
  end: number;
}

/**
 * Parse the table printed by
 * `netsh interface ipv4 show excludedportrange protocol=tcp`.
 *
 * Output shape (Windows-localised header/legend text may vary, but the
 * data rows are always two integers, optionally followed by a `*` legend
 * marker):
 *
 *   Protocol tcp Port Exclusion Ranges
 *
 *   Start Port    End Port
 *   ----------    --------
 *        50000       50059    *
 *        50060       50159
 *
 *   * - Administered port exclusions.
 *
 * Returns an empty array both when nothing parses (e.g. localised/garbled
 * output) AND when the table parsed cleanly but has zero data rows (a
 * healthy machine with no reservations). Callers must not conflate the two —
 * see {@link looksLikeExcludedPortRangeTable}, which tells them apart.
 */
export function parseExcludedPortRanges(raw: string): PortRange[] {
  const ranges: PortRange[] = [];
  const lines = raw.split(/\r?\n/);
  for (const line of lines) {
    const match = line.trim().match(/^(\d+)\s+(\d+)(?:\s+\*)?$/);
    if (!match) continue;
    const start = Number(match[1]);
    const end = Number(match[2]);
    if (Number.isInteger(start) && Number.isInteger(end) && start <= end) {
      ranges.push({ start, end });
    }
  }
  return ranges;
}

/**
 * True when `raw` contains the table's header or separator row, i.e. netsh
 * produced recognisable output even if it listed zero ranges. Without this,
 * `parseExcludedPortRanges` returning `[]` is ambiguous between "parsed, no
 * reservations" (a normal healthy machine) and "did not parse" (localised or
 * garbled output) — GitHub issue #100.
 */
export function looksLikeExcludedPortRangeTable(raw: string): boolean {
  return /Start Port\s+End Port/i.test(raw) || /-{4,}\s+-{4,}/.test(raw);
}

/** Find the first reserved range (if any) that contains `port`. */
export function findContainingRange(ranges: PortRange[], port: number): PortRange | undefined {
  return ranges.find((r) => port >= r.start && port <= r.end);
}

export interface ReservedPortReport {
  /** True when the check could not be completed and should render as a single skip row. */
  skip: boolean;
  skipReason?: "non-windows" | "netsh-unavailable" | "unparseable";
  ranges: PortRange[];
}

/**
 * Read the current reserved TCP port ranges from `netsh`.
 *
 * Deliberately UNCACHED — the reserved blocks move without a reboot (two
 * readings an hour apart on the same machine differed), so every doctor run
 * must query live. See GitHub issue #100.
 */
export function detectReservedPortRanges(): ReservedPortReport {
  if (process.platform !== "win32") {
    return { skip: true, skipReason: "non-windows", ranges: [] };
  }

  let raw: string;
  try {
    raw = execFileSync(
      "netsh",
      ["interface", "ipv4", "show", "excludedportrange", "protocol=tcp"],
      { encoding: "utf8", timeout: NETSH_TIMEOUT_MS, windowsHide: true }
    );
  } catch {
    return { skip: true, skipReason: "netsh-unavailable", ranges: [] };
  }

  const ranges = parseExcludedPortRanges(raw);
  if (ranges.length === 0 && !looksLikeExcludedPortRangeTable(raw)) {
    return { skip: true, skipReason: "unparseable", ranges: [] };
  }

  // Parsed successfully with zero rows — a healthy machine with no reserved
  // ranges, not a parse failure. Report `ok` with an empty list.
  return { skip: false, ranges };
}
