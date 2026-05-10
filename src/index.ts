#!/usr/bin/env node
// Suppress Node.js experimental-feature warnings (e.g. SQLite) from user output
process.removeAllListeners("warning");

import { detectBrokenInstall, emitInstallErrorOverMcp, attemptSelfRepair } from "./install-doctor.js";

const subcommand = process.argv[2];

if (subcommand === "mcp") {
  // MCP path: check install first, then lazy-import heavy modules
  const broken = detectBrokenInstall();
  if (broken) {
    emitInstallErrorOverMcp(broken).catch((err) => {
      process.stderr.write(`scrybe mcp error: ${err}\n`);
    }).finally(() => {
      process.exit(0);
    });
  } else {
    Promise.all([import("./mcp-server.js"), import("./jobs.js")])
      .then(([{ runMcpServer }, { cancelAllJobs }]) => {
        for (const sig of ["SIGTERM", "SIGINT"] as const) {
          process.on(sig, () => {
            cancelAllJobs();
            process.exit(0);
          });
        }
        return runMcpServer();
      })
      .catch((err) => {
        process.stderr.write(`scrybe mcp error: ${err}\n`);
        process.exit(1);
      });
  }
} else {
  // CLI path: check install first, attempt repair if broken, then lazy-import
  const broken = detectBrokenInstall();
  if (broken) {
    const repaired = attemptSelfRepair(broken);
    if (!repaired) {
      // Not in npx cache or repair failed — print recovery text and exit
      process.stderr.write(
        "[scrybe] Install incomplete. Run `scrybe doctor` for diagnostics.\n",
      );
      process.exit(1);
    }
    // repair spawned re-exec — this process will exit via child.on("close")
    // hang here so we don't fall through to runCli
  } else {
    Promise.all([import("./cli.js"), import("./jobs.js")])
      .then(([{ runCli }, { cancelAllJobs }]) => {
        for (const sig of ["SIGTERM", "SIGINT"] as const) {
          process.on(sig, () => {
            cancelAllJobs();
            process.exit(0);
          });
        }
        return runCli();
      })
      .catch((err) => {
        process.stderr.write(`scrybe error: ${err}\n`);
        process.exit(1);
      });
  }
}
