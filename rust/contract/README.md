# Contract suite

Drives a scrybe build from the outside, through the MCP client and the command line, so the same tests judge either build. It uses a throwaway git repo, a throwaway data dir and a fake embedding endpoint, so it needs no model download and takes seconds, not minutes.

```
SCRYBE_CONTRACT_BUILD=rust \
SCRYBE_CONTRACT_SERVER='["<path>/scrybe-rs","serve"]' \
SCRYBE_CONTRACT_CLI='["<path>/scrybe-rs"]' \
SCRYBE_CONTRACT_RELAY='["<path>/scrybe-relay"]' \
node --test rust/contract/contract.test.mjs
```

For the TypeScript build, use `SCRYBE_CONTRACT_BUILD=ts`, `["node","<dist>/index.js","daemon","start"]` as the server and `["node","<dist>/index.js"]` as the command line.

The GitLab issues tests read the knowledge table with the Node LanceDB package. They find it next to a TypeScript `dist` command line, or in the `node_modules` named by `SCRYBE_CONTRACT_NODE_MODULES`; with neither they skip.

A test the Rust build can't pass yet is listed in `RUST_GAPS` and runs as a todo. A tool it doesn't have yet shows as skipped. Neither counts as a pass.
