import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync, writeFileSync, readFileSync, existsSync } from "fs";
import { join } from "path";
import { tmpdir } from "os";
import { createBackup } from "../src/util/backup.js";

let tmp = "";

beforeEach(() => {
  tmp = mkdtempSync(join(tmpdir(), "scrybe-backup-test-"));
});

afterEach(() => {
  rmSync(tmp, { recursive: true, force: true });
});

describe("createBackup", () => {
  it("creates a backup file with expected suffix", () => {
    const src = join(tmp, "myfile.json");
    writeFileSync(src, '{"a":1}');
    const bak = createBackup(src);
    expect(bak).toMatch(/\.scrybe-backup-\d+$/);
    expect(existsSync(bak)).toBe(true);
  });

  it("backup contents match original", () => {
    const src = join(tmp, "myfile.json");
    const content = '{"hello":"world"}';
    writeFileSync(src, content);
    const bak = createBackup(src);
    expect(readFileSync(bak, "utf8")).toBe(content);
  });

  it("original file is untouched after backup", () => {
    const src = join(tmp, "myfile.json");
    const content = "original content";
    writeFileSync(src, content);
    createBackup(src);
    expect(readFileSync(src, "utf8")).toBe(content);
  });

  it("throws if source file does not exist", () => {
    const missing = join(tmp, "nonexistent.json");
    expect(() => createBackup(missing)).toThrow(/Cannot back up missing file/);
  });

  it("backup path is alongside original", () => {
    const src = join(tmp, "config.json");
    writeFileSync(src, "{}");
    const bak = createBackup(src);
    expect(bak.startsWith(src)).toBe(true);
  });
});
