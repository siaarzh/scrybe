import { execFileSync } from "child_process";

export interface GitExecOpts {
  cwd: string;
  /** Whether to trim trailing whitespace from stdout. Default: true. */
  trim?: boolean;
  /** Maximum stdout buffer size in bytes. Default: Node's execFileSync default (1 MB). */
  maxBuffer?: number;
  /** Timeout in milliseconds. Default: no timeout. */
  timeout?: number;
}

/**
 * Run `git <args>` via execFileSync (no shell interpolation).
 * Returns stdout (trimmed by default), or null on any failure.
 */
export function gitExec(args: string[], opts: GitExecOpts): string | null {
  try {
    const out = execFileSync("git", args, {
      cwd: opts.cwd,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
      ...(opts.maxBuffer !== undefined ? { maxBuffer: opts.maxBuffer } : {}),
      ...(opts.timeout !== undefined ? { timeout: opts.timeout } : {}),
    });
    return opts.trim === false ? out : out.trim();
  } catch {
    return null;
  }
}

/**
 * Run `git <args>` via execFileSync (no shell interpolation).
 * Returns stdout (trimmed by default). Throws on failure.
 * Use for paths where failure must propagate (e.g. ref validation).
 */
export function gitExecOrThrow(args: string[], opts: GitExecOpts): string {
  const out = execFileSync("git", args, {
    cwd: opts.cwd,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "ignore"],
    ...(opts.maxBuffer !== undefined ? { maxBuffer: opts.maxBuffer } : {}),
    ...(opts.timeout !== undefined ? { timeout: opts.timeout } : {}),
  });
  return opts.trim === false ? out : out.trim();
}
