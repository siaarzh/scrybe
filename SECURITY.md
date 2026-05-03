# Security Policy

## Scope

This policy covers:
- The `scrybe-cli` npm package
- The MCP tools exposed under the `mcp__scrybe__*` namespace
- The daemon's localhost HTTP API (`127.0.0.1` only, not accessible over the network)

Out of scope:
- MCP host clients themselves (Claude Code, Cline, Cursor, etc.)
- LanceDB upstream library
- HuggingFace model integrity and supply chain
- The local OS environment on which scrybe runs

## Reporting a Vulnerability

Please **do not** open a public GitHub issue for security vulnerabilities.

Email `siaarzh@gmail.com` with a description of the issue, steps to reproduce, and potential impact.
You will receive an acknowledgement within 72 hours and a resolution or status update within **90 days**.

Alternatively, use GitHub's [Private vulnerability reporting](https://docs.github.com/en/code-security/security-advisories/guidance-on-reporting-and-writing-information-about-vulnerabilities/privately-reporting-a-security-vulnerability)
if you prefer to stay within the GitHub interface.

## Bug Bounty

There is no bug bounty program. This is a solo maintainer open-source project.

## Supported Versions

Only the latest release on npm (`scrybe-cli`) receives security fixes.
