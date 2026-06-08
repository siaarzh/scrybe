/**
 * MCP tool: status
 *
 * Quick state snapshot — config present? daemon running + version?
 * Embedding provider/model configured? Does NOT run the full check suite;
 * for a deep health report use the `doctor` tool instead.
 */

import type { Tool } from "./types.js";

// ─── Output type ──────────────────────────────────────────────────────────────

export interface StatusOutput {
  /** Scrybe version from package.json. */
  version: string;
  /** True when config.json exists and is well-formed. */
  config_present: boolean;
  /** True when the daemon pidfile exists and the process is alive. */
  daemon_running: boolean;
  /** Daemon PID when running, otherwise null. */
  daemon_pid: number | null;
  /** Daemon HTTP port when running, otherwise null. */
  daemon_port: number | null;
  /** Daemon version string reported by /health, or null when not reachable. */
  daemon_version: string | null;
  /** Embedding provider type for code sources: "local" | "api". */
  code_provider_type: string;
  /** Embedding model for code sources. */
  code_model: string;
  /** Embedding provider type for knowledge sources: "local" | "api". */
  text_provider_type: string;
  /** Embedding model for knowledge sources. */
  text_model: string;
  /** True when SCRYBE_CODE_EMBEDDING_API_KEY is set (API providers only). */
  api_key_present: boolean;
  /** True when there is a config error (misconfigured provider). */
  config_error: boolean;
  /** Config error message when config_error is true, otherwise null. */
  config_error_message: string | null;
}

// ─── Tool definition ──────────────────────────────────────────────────────────

export const statusTool: Tool<Record<string, never>, StatusOutput> = {
  spec: {
    name: "status",
    description:
      "Return a quick scrybe status snapshot: config present, daemon running, " +
      "embedding provider/model, and API key presence. " +
      "This is a lightweight read-only call — it does not validate credentials or run checks. " +
      "For a full health check with remediation advice, use the `doctor` tool instead.",
    inputSchema: {
      type: "object",
      properties: {},
      required: [],
    },
    annotations: { readOnlyHint: true, openWorldHint: false },
  },

  handler: async () => {
    // Lazy-load all state sources to avoid forcing heavy modules at parse time
    const { config, VERSION, readScrybeConfig } = await import("../config.js");
    const { readPidfile, isDaemonRunning } = await import("../daemon/pidfile.js");

    // Config presence
    const configObj = readScrybeConfig();
    const configPresent = configObj !== null;

    // Config error
    const configError = !!config.embeddingConfigError;
    const configErrorMessage = config.embeddingConfigError ?? null;

    // Daemon state (quick: pid alive check only, no HTTP probe)
    const pidData = readPidfile();
    let daemonRunning = false;
    let daemonPid: number | null = null;
    let daemonPort: number | null = null;
    let daemonVersion: string | null = null;

    if (pidData) {
      const { running } = await isDaemonRunning();
      if (running) {
        daemonRunning = true;
        daemonPid = pidData.pid;
        daemonPort = pidData.port;
        // Best-effort HTTP version probe (short timeout)
        try {
          // lgtm[js/file-access-to-http] -- loopback only; port from pidfile owned by current user
          const res = await fetch(`http://127.0.0.1:${pidData.port}/health`, {
            signal: AbortSignal.timeout(2000),
          });
          if (res.ok) {
            const body = await res.json() as { version?: string };
            daemonVersion = body.version ?? null;
          }
        } catch {
          // Daemon running per pidfile but HTTP not reachable — leave daemonVersion null
        }
      }
    }

    return {
      version: VERSION,
      config_present: configPresent,
      daemon_running: daemonRunning,
      daemon_pid: daemonPid,
      daemon_port: daemonPort,
      daemon_version: daemonVersion,
      code_provider_type: config.embeddingProviderType,
      code_model: config.embeddingModel,
      text_provider_type: config.textEmbeddingProviderType,
      text_model: config.textEmbeddingModel,
      api_key_present: !!config.embeddingApiKey,
      config_error: configError,
      config_error_message: configErrorMessage,
    };
  },
};
