/**
 * Windows AV detection for `scrybe doctor`.
 *
 * Queries SecurityCenter2 WMI for registered AV products, and Defender
 * status via Get-MpComputerStatus / Get-MpPreference.  All PowerShell
 * calls are time-budgeted to ≤2 s; on timeout the entire section returns
 * a single skip-classed report so doctor never hangs.
 *
 * Only runs on Windows (process.platform === "win32").
 * On other platforms `detectWindowsAv()` returns immediately with
 * `{ skip: true }`.
 */

import { spawnSync } from "child_process";

// ── Constants ────────────────────────────────────────────────────────────────

const DEFENDER_GUID = "{D68DDC3A-831F-4fae-9E44-DA132C1ACF46}";
const PS_TIMEOUT_MS = 2_000;
const README_ANCHOR = "#windows-av";

/** AMRunningMode values that indicate Defender is actively scanning. */
const ACTIVE_AM_MODES = new Set(["Normal", "Passive", "EDR Block Mode", "SxS Passive Mode"]);

// ── productState bitfield helpers ────────────────────────────────────────────

/**
 * Decode the `productState` bitfield returned by SecurityCenter2.
 *
 * Microsoft never published a full spec; only these two bits are reliable:
 *   bit 12 (0x1000) — real-time protection enabled
 *   bit 4  (0x0010) — signatures up-to-date
 */
export function decodeProductState(state: number): { realTimeEnabled: boolean; signaturesUpToDate: boolean } {
  return {
    realTimeEnabled: (state & 0x1000) !== 0,
    signaturesUpToDate: (state & 0x0010) !== 0,
  };
}

// ── PowerShell helper ────────────────────────────────────────────────────────

/**
 * Run a PowerShell snippet and return its stdout as a string, or `null` on
 * error / timeout.  Always uses `-NoProfile` to skip user profile scripts.
 */
function runPs(command: string): string | null {
  const result = spawnSync(
    "powershell.exe",
    ["-NoProfile", "-NonInteractive", "-Command", command],
    { encoding: "utf8", timeout: PS_TIMEOUT_MS, stdio: "pipe", windowsHide: true }
  );
  if (result.error || result.status !== 0) return null;
  return result.stdout?.trim() ?? null;
}

// ── AV product detection ─────────────────────────────────────────────────────

interface AvProduct {
  displayName: string;
  productState: number;
  pathToSignedReportingExe?: string;
}

function isDefender(p: AvProduct): boolean {
  const nameLower = p.displayName.toLowerCase();
  return nameLower.includes("windows defender") || nameLower.includes(DEFENDER_GUID.toLowerCase());
}

function isMalwarebytes(p: AvProduct): boolean {
  return p.displayName.toLowerCase().includes("malwarebytes");
}

/** Fetch registered AV products from SecurityCenter2. Returns null on failure. */
function getAvProducts(): AvProduct[] | null {
  const raw = runPs(
    "Get-CimInstance -Namespace root/SecurityCenter2 -ClassName AntiVirusProduct " +
    "| Select-Object displayName, productState, pathToSignedReportingExe " +
    "| ConvertTo-Json -Compress -Depth 3"
  );
  if (!raw) return null;
  try {
    const parsed = JSON.parse(raw);
    // May be a single object or an array
    const arr: AvProduct[] = Array.isArray(parsed) ? parsed : [parsed];
    return arr.filter((p) => p && typeof p.displayName === "string");
  } catch {
    return null;
  }
}

interface MpStatus {
  AMRunningMode: string | null;
  RealTimeProtectionEnabled: boolean;
  IsTamperProtected: boolean;
}

/** Get Defender / MpComputerStatus. Returns null if Defender not installed. */
function getMpStatus(): MpStatus | null {
  const raw = runPs(
    "(Get-MpComputerStatus | Select-Object AMRunningMode, RealTimeProtectionEnabled, IsTamperProtected) " +
    "| ConvertTo-Json -Compress"
  );
  if (!raw) return null;
  try {
    const parsed = JSON.parse(raw) as Record<string, unknown>;
    return {
      AMRunningMode: typeof parsed["AMRunningMode"] === "string" ? parsed["AMRunningMode"] : null,
      RealTimeProtectionEnabled: !!parsed["RealTimeProtectionEnabled"],
      IsTamperProtected: !!parsed["IsTamperProtected"],
    };
  } catch {
    return null;
  }
}

interface MpPrefs {
  ExclusionPath: string[];
}

/** Get Defender exclusion paths. Returns null on failure. */
function getMpPrefs(): MpPrefs | null {
  const raw = runPs(
    "(Get-MpPreference | Select-Object ExclusionPath, ExclusionProcess) | ConvertTo-Json -Compress"
  );
  if (!raw) return null;
  try {
    const parsed = JSON.parse(raw) as Record<string, unknown>;
    const paths = parsed["ExclusionPath"];
    return {
      ExclusionPath: Array.isArray(paths) ? paths.filter((p): p is string => typeof p === "string") :
        typeof paths === "string" ? [paths] : [],
    };
  } catch {
    return null;
  }
}

// ── Public API ───────────────────────────────────────────────────────────────

export interface WindowsAvReport {
  /**
   * True when the AV section should be emitted as a single `skip` row
   * (non-Windows, PowerShell timeout, or Defender service not installed).
   */
  skip: boolean;
  skipReason?: string;

  /** Defender rows — present when Defender service is detected. */
  defender?: {
    runningMode: string;                // AMRunningMode value (or "Not running")
    realTimeEnabled: boolean;
    exclusions: string[];               // ExclusionPath list from Get-MpPreference
    dataDir?: string;                   // The scrybe dataDir path, for exclusion check
    dataDirExcluded?: boolean;
    registered: boolean;               // Was Defender found in SecurityCenter2?
    active: boolean;                   // AMRunningMode in ACTIVE_AM_MODES
  };

  /** True when MBAM was found as a registered AV product. */
  mbamDetected: boolean;

  /** True when Defender is not running AND no other AV is registered. */
  noActiveAv: boolean;
}

/**
 * Detect Windows AV products and Defender exclusion state.
 *
 * Must only be called from `runDoctor()`; exported for testing.
 * On non-Windows returns `{ skip: true, skipReason: "non-windows", mbamDetected: false, noActiveAv: false }`.
 */
export async function detectWindowsAv(dataDir?: string): Promise<WindowsAvReport> {
  if (process.platform !== "win32") {
    return { skip: true, skipReason: "non-windows", mbamDetected: false, noActiveAv: false };
  }

  // Query SecurityCenter2 for registered products
  const products = getAvProducts();
  if (products === null) {
    // Timeout or PowerShell error on the first call
    return { skip: true, skipReason: "powershell-timeout-or-error", mbamDetected: false, noActiveAv: false };
  }

  const mbamProduct = products.find(isMalwarebytes);
  const mbamDetected = !!mbamProduct;

  // Defender detection: by display name OR by being the only product remaining
  const defenderProduct = products.find(isDefender);

  // Query Defender status (may fail if Defender service not installed at all)
  const mpStatus = getMpStatus();

  if (!mpStatus) {
    // Defender service not installed → entire AV section skip (per §3 decision matrix: "Service not installed at all → Skip Windows-AV section entirely")
    return { skip: true, skipReason: "defender-not-installed", mbamDetected, noActiveAv: false };
  }

  const runningMode = mpStatus.AMRunningMode ?? "Unknown";
  const defenderActive = ACTIVE_AM_MODES.has(runningMode);

  // Check exclusions only when Defender is active (primary or passive)
  let exclusions: string[] = [];
  if (defenderActive) {
    const prefs = getMpPrefs();
    exclusions = prefs?.ExclusionPath ?? [];
  }

  const dataDirExcluded = dataDir
    ? exclusions.some((e) => e.toLowerCase() === dataDir.toLowerCase() ||
                             dataDir.toLowerCase().startsWith(e.toLowerCase() + "\\") ||
                             dataDir.toLowerCase().startsWith(e.toLowerCase() + "/"))
    : undefined;

  // No active AV: Defender not running AND no other AV product is registered
  // as active (using productState bit 12 = real-time enabled)
  const anyOtherActiveAv = products
    .filter((p) => !isDefender(p))
    .some((p) => decodeProductState(p.productState).realTimeEnabled);

  const noActiveAv = !defenderActive && !anyOtherActiveAv;

  return {
    skip: false,
    defender: {
      runningMode,
      realTimeEnabled: mpStatus.RealTimeProtectionEnabled,
      exclusions,
      dataDir,
      dataDirExcluded,
      registered: !!defenderProduct,
      active: defenderActive,
    },
    mbamDetected,
    noActiveAv,
  };
}

// ── Row-builder helpers (consumed by doctor.ts) ──────────────────────────────

export const AV_README_ANCHOR = README_ANCHOR;
