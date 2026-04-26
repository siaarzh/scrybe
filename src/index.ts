#!/usr/bin/env node
// Suppress Node.js experimental-feature warnings (e.g. SQLite) from user output
process.removeAllListeners("warning");
import { runMcpServer } from "./mcp-server.js";
import { runCli } from "./cli.js";
import { cancelAllJobs } from "./jobs.js";

for (const sig of ["SIGTERM", "SIGINT"] as const) {
  process.on(sig, () => {
    cancelAllJobs();
    process.exit(0);
  });
}

const subcommand = process.argv[2];

if (subcommand === "mcp") {
  runMcpServer().catch((err) => {
    process.stderr.write(`scrybe mcp error: ${err}\n`);
    process.exit(1);
  });
} else {
  runCli().catch((err) => {
    process.stderr.write(`scrybe error: ${err}\n`);
    process.exit(1);
  });
}
