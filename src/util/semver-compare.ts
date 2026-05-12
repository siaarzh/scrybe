/**
 * SemVer comparison — extract major.minor.patch and compare.
 * Returns -1 (left < right), 0 (equal), 1 (left > right), or null (parse error).
 */
export function compareSemVer(left: string, right: string): -1 | 0 | 1 | null {
  const parseVersion = (v: string): [number, number, number] | null => {
    const match = v.match(/^(\d+)\.(\d+)\.(\d+)/);
    if (!match) return null;
    return [parseInt(match[1], 10), parseInt(match[2], 10), parseInt(match[3], 10)];
  };

  const l = parseVersion(left);
  const r = parseVersion(right);
  if (!l || !r) return null;

  const [lMajor, lMinor, lPatch] = l;
  const [rMajor, rMinor, rPatch] = r;

  if (lMajor !== rMajor) return lMajor < rMajor ? -1 : 1;
  if (lMinor !== rMinor) return lMinor < rMinor ? -1 : 1;
  if (lPatch !== rPatch) return lPatch < rPatch ? -1 : 1;
  return 0;
}

/**
 * Extract major version number. Returns null if parse fails.
 */
export function getMajorVersion(v: string): number | null {
  const match = v.match(/^(\d+)\./);
  if (!match) return null;
  return parseInt(match[1], 10);
}

/**
 * Extract minor version number. Returns null if parse fails.
 */
export function getMinorVersion(v: string): number | null {
  const match = v.match(/^(\d+)\.(\d+)\./);
  if (!match) return null;
  return parseInt(match[2], 10);
}
