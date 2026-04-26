/**
 * Tests for the snapshot redaction serializer.
 */
import { describe, it, expect } from "vitest";
import { redact } from "./serializers.js";

describe("redact — path normalization", () => {
  it("normalizes Windows backslashes", () => {
    expect(redact("C:\\Users\\foo\\scrybe-scenario-abc123\\data")).toContain("<TMPDIR>");
  });

  it("redacts Unix scenario temp paths", () => {
    expect(redact("/tmp/scrybe-scenario-abc123/lancedb")).toContain("<TMPDIR>");
  });

  it("redacts repo temp paths", () => {
    expect(redact("/tmp/scrybe-repo-xyz456/src")).toContain("<REPODIR>");
  });

  it("leaves stable paths untouched", () => {
    const stable = "/usr/local/bin/node";
    expect(redact(stable)).toBe(stable);
  });
});

describe("redact — timestamps", () => {
  it("redacts ISO 8601 timestamps", () => {
    expect(redact("2026-04-26T18:00:00.000Z")).toBe("<TIMESTAMP>");
  });

  it("redacts relative times", () => {
    expect(redact("5m ago")).toContain("<AGO>");
    expect(redact("2d ago")).toContain("<AGO>");
    expect(redact("just now")).toContain("<AGO>");
  });
});

describe("redact — sizes and versions", () => {
  it("redacts file sizes", () => {
    expect(redact("7.3 GB")).toContain("<SIZE>");
    expect(redact("142.5 MB")).toContain("<SIZE>");
    expect(redact("256 KB")).toContain("<SIZE>");
  });

  it("redacts version counts", () => {
    expect(redact("14 versions")).toContain("<VCOUNT> versions");
  });

  it("redacts chunk counts", () => {
    expect(redact("52,633 chunks")).toContain("<N> chunks");
  });
});

describe("redact — PIDs and ports", () => {
  it("redacts PIDs", () => {
    expect(redact("PID 12345")).toContain("PID <PID>");
  });

  it("redacts ports", () => {
    expect(redact("port 49152")).toContain("port <PORT>");
  });
});

describe("redact — version strings", () => {
  it("redacts version strings", () => {
    expect(redact("Scrybe v0.24.0")).toContain("v<VERSION>");
  });
});

describe("redact — stable text", () => {
  it("does not redact non-dynamic text", () => {
    const stable = "Project registered successfully.";
    expect(redact(stable)).toBe(stable);
  });

  it("preserves newlines and whitespace structure", () => {
    const text = "  ✓  primary             code       1,234 chunks  — just now\n";
    const result = redact(text);
    expect(result).toContain("primary");
    expect(result).toContain("code");
    expect(result).toContain("<N> chunks");
  });
});
