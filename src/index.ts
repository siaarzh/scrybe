#!/usr/bin/env node
import { runMcpServer } from "./mcp-server.js";
import { runCli } from "./cli.js";

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
