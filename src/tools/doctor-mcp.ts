/**
 * MCP tool: doctor
 *
 * Thin wrapper over src/onboarding/doctor.ts runDoctor(). Returns the full
 * DoctorReport as structured MCP output, including all CheckResult.remedy
 * fields so callers can surface fix instructions without consulting docs.
 *
 * Extension point: new CheckResult rows (e.g. model.dims_match from gh#5,
 * npm-prefix check from gh#34) are added directly inside doctor.ts's check
 * list — no changes needed here.
 */

import { runDoctor } from "../onboarding/doctor.js";
import type { DoctorReport } from "../onboarding/doctor.js";
import type { Tool } from "./types.js";

// ─── Input / Output types ─────────────────────────────────────────────────────

export interface DoctorInput {
  /**
   * Optional section filter. When provided, only checks whose `section`
   * matches this string are returned. Omit to get all checks.
   */
  section?: string;
}

export type DoctorOutput = DoctorReport & {
  /** True if there are no fail-status checks. */
  healthy: boolean;
};

// ─── Tool definition ──────────────────────────────────────────────────────────

export const doctorTool: Tool<DoctorInput, DoctorOutput> = {
  spec: {
    name: "doctor",
    description:
      "Run a full scrybe health check and return a structured report. " +
      "Checks cover: install integrity, Node version, DATA_DIR, embedding provider config & auth, " +
      "data integrity (schema version, LanceDB tables, branch-tags.db), registered project freshness, " +
      "daemon status (pidfile, HTTP health, autostart), git hooks, fetch-poller sync, and MCP config. " +
      "Each check result includes an optional `remedy` field with actionable fix instructions. " +
      "Use `section` to filter results to a specific category (e.g. 'Daemon', 'Embedding Provider'). " +
      "Returns `healthy: true` when there are no `fail`-status checks.",
    inputSchema: {
      type: "object",
      properties: {
        section: {
          type: "string",
          description:
            "Optional section filter. Limits returned checks to those whose `section` " +
            "matches this value. Example: 'Daemon', 'Embedding Provider', 'Data Integrity'. " +
            "Omit to return all checks.",
        },
      },
      required: [],
    },
    annotations: { readOnlyHint: true, openWorldHint: false },
  },

  handler: async (input) => {
    const report = await runDoctor();

    const checks = input.section
      ? report.checks.filter((c) => c.section === input.section)
      : report.checks;

    // Recompute summary when section filter is active
    const summary = input.section
      ? checks.reduce(
          (acc, c) => { acc[c.status]++; return acc; },
          { ok: 0, warn: 0, fail: 0, skip: 0 }
        )
      : report.summary;

    const healthy = summary.fail === 0;

    return {
      ...report,
      checks,
      summary,
      healthy,
    };
  },
};
