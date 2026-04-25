import { spawn } from "child_process";

/**
 * Spawns `scrybe daemon start` as a detached, fully independent process.
 * The spawned process is unref'd immediately so it outlives the parent.
 *
 * Uses process.execPath (node binary) + process.argv[1] (dist/index.js or the
 * globally-installed scrybe script) so it works in both dev and production.
 */
export function spawnDaemonDetached(opts: {
  execPath?: string;
  entryScript?: string;
  env?: NodeJS.ProcessEnv;
}): void {
  const node   = opts.execPath   ?? process.execPath;
  const script = opts.entryScript ?? process.argv[1]!;
  const env    = opts.env ?? process.env;

  const child = spawn(node, [script, "daemon", "start"], {
    detached: true,
    stdio: "ignore",
    env,
  });
  child.unref();
}
