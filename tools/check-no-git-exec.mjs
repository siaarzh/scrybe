/**
 * Walks src/ and npm-hooks/ and exits non-zero if any line matches
 * execSync with a git argument — all git calls must route through gitExec/gitExecOrThrow.
 */
import { readdirSync, readFileSync, statSync } from "fs";
import { join } from "path";

const PATTERN = /execSync\([^)]*\bgit\b/;
const ROOTS = ["src", "npm-hooks"];

function walk(dir) {
  const entries = readdirSync(dir);
  const files = [];
  for (const entry of entries) {
    const full = join(dir, entry);
    const stat = statSync(full);
    if (stat.isDirectory()) {
      files.push(...walk(full));
    } else {
      files.push(full);
    }
  }
  return files;
}

let found = 0;
for (const root of ROOTS) {
  let files;
  try {
    files = walk(root);
  } catch {
    // root may not exist in all environments — skip silently
    continue;
  }
  for (const file of files) {
    const content = readFileSync(file, "utf8");
    const lines = content.split("\n");
    for (let i = 0; i < lines.length; i++) {
      if (PATTERN.test(lines[i])) {
        console.error(`${file}:${i + 1}: forbidden execSync git call`);
        found++;
      }
    }
  }
}

if (found > 0) {
  console.error(`\n${found} forbidden call(s) found. Route git invocations through gitExec/gitExecOrThrow.`);
  process.exit(1);
}
