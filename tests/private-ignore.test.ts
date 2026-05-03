/**
 * Unit tests for src/private-ignore.ts (Plan 26).
 */
import { describe, it, expect } from "vitest";
import { join } from "path";
import { writeFileSync, mkdirSync, existsSync } from "fs";

describe("getPrivateIgnorePath", () => {
  it("builds the correct DATA_DIR path", async () => {
    const { getPrivateIgnorePath } = await import("../src/private-ignore.js");
    const { config } = await import("../src/config.js");
    const result = getPrivateIgnorePath("my-project", "primary");
    expect(result).toBe(join(config.dataDir, "ignores", "my-project", "primary.gitignore"));
  });
});

describe("loadPrivateIgnore", () => {
  it("returns null for a missing file", async () => {
    const { loadPrivateIgnore } = await import("../src/private-ignore.js");
    const result = loadPrivateIgnore("nonexistent-proj", "nonexistent-src");
    expect(result).toBeNull();
  });

  it("returns content when file exists", async () => {
    const { loadPrivateIgnore, getPrivateIgnorePath } = await import("../src/private-ignore.js");
    const { config } = await import("../src/config.js");
    const path = getPrivateIgnorePath("test-proj-load", "primary");
    mkdirSync(join(config.dataDir, "ignores", "test-proj-load"), { recursive: true });
    writeFileSync(path, "vendor/\n", "utf8");
    const result = loadPrivateIgnore("test-proj-load", "primary");
    expect(result).toBe("vendor/\n");
  });
});

describe("isMissingOrEmpty", () => {
  it("returns true for null (missing file)", async () => {
    const { isMissingOrEmpty } = await import("../src/private-ignore.js");
    expect(isMissingOrEmpty(null)).toBe(true);
  });

  it("returns true for empty string", async () => {
    const { isMissingOrEmpty } = await import("../src/private-ignore.js");
    expect(isMissingOrEmpty("")).toBe(true);
  });

  it("returns true for comment-only content", async () => {
    const { isMissingOrEmpty } = await import("../src/private-ignore.js");
    expect(isMissingOrEmpty("# This is a comment\n# Another comment\n")).toBe(true);
  });

  it("returns true for whitespace-only content", async () => {
    const { isMissingOrEmpty } = await import("../src/private-ignore.js");
    expect(isMissingOrEmpty("  \n\t\n  ")).toBe(true);
  });

  it("returns true for mixed comments and whitespace", async () => {
    const { isMissingOrEmpty } = await import("../src/private-ignore.js");
    expect(isMissingOrEmpty("# header\n\n# another\n  \n")).toBe(true);
  });

  it("returns false for a file with at least one non-comment non-whitespace line", async () => {
    const { isMissingOrEmpty } = await import("../src/private-ignore.js");
    expect(isMissingOrEmpty("# comment\nvendor/\n")).toBe(false);
  });

  it("returns false for content with only a pattern (no comments)", async () => {
    const { isMissingOrEmpty } = await import("../src/private-ignore.js");
    expect(isMissingOrEmpty("vendor/")).toBe(false);
  });
});

describe("countRules", () => {
  it("returns 0 for null", async () => {
    const { countRules } = await import("../src/private-ignore.js");
    expect(countRules(null)).toBe(0);
  });

  it("returns 0 for comment-only content", async () => {
    const { countRules } = await import("../src/private-ignore.js");
    expect(countRules("# comment\n")).toBe(0);
  });

  it("counts actual rules", async () => {
    const { countRules } = await import("../src/private-ignore.js");
    expect(countRules("# comment\nvendor/\n*.log\n")).toBe(2);
  });
});

describe("savePrivateIgnore", () => {
  it("creates the file when given content", async () => {
    const { savePrivateIgnore, loadPrivateIgnore } = await import("../src/private-ignore.js");
    const content = "vendor/\n*.log\n";
    savePrivateIgnore("save-test", "primary", content);
    const loaded = loadPrivateIgnore("save-test", "primary");
    expect(loaded).toBe(content);
  });

  it("deletes the file when given null", async () => {
    const { savePrivateIgnore, getPrivateIgnorePath, loadPrivateIgnore } = await import("../src/private-ignore.js");
    savePrivateIgnore("delete-test", "primary", "vendor/\n");
    savePrivateIgnore("delete-test", "primary", null);
    const path = getPrivateIgnorePath("delete-test", "primary");
    expect(existsSync(path)).toBe(false);
    expect(loadPrivateIgnore("delete-test", "primary")).toBeNull();
  });

  it("deletes the file when given empty string", async () => {
    const { savePrivateIgnore, getPrivateIgnorePath } = await import("../src/private-ignore.js");
    savePrivateIgnore("empty-test", "primary", "vendor/\n");
    savePrivateIgnore("empty-test", "primary", "");
    const path = getPrivateIgnorePath("empty-test", "primary");
    expect(existsSync(path)).toBe(false);
  });
});

describe("checkIgnoreCoverage", () => {
  it("reports hasCoverage=true when private ignore has rules", async () => {
    const { checkIgnoreCoverage, savePrivateIgnore } = await import("../src/private-ignore.js");
    // Create private ignore rules
    savePrivateIgnore("cover-test", "primary", "vendor/\n");
    // rootPath doesn't matter here as long as git show fails gracefully
    const result = checkIgnoreCoverage("/nonexistent/path", "main", "cover-test", "primary");
    expect(result.hasCoverage).toBe(true);
    expect(result.hasPrivateIgnore).toBe(true);
    expect(result.message).toBeNull();
  });

  it("reports hasCoverage=false with warning when both are missing", async () => {
    const { checkIgnoreCoverage } = await import("../src/private-ignore.js");
    const result = checkIgnoreCoverage("/nonexistent/path", "docs", "cover-missing", "primary");
    expect(result.hasCoverage).toBe(false);
    expect(result.hasCommittedIgnore).toBe(false);
    expect(result.hasPrivateIgnore).toBe(false);
    expect(result.message).toContain("has no .scrybeignore");
    expect(result.message).toContain("cover-missing/primary");
    expect(result.message).toContain("scrybe ignore");
  });

  it("reports hasCoverage=false when private ignore is comment-only", async () => {
    const { checkIgnoreCoverage, savePrivateIgnore } = await import("../src/private-ignore.js");
    savePrivateIgnore("cover-comment", "primary", "# just a comment\n");
    const result = checkIgnoreCoverage("/nonexistent/path", "feature", "cover-comment", "primary");
    expect(result.hasCoverage).toBe(false);
    expect(result.hasPrivateIgnore).toBe(false);
  });
});
