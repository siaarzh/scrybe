import { describe, it, expect } from "vitest";
import { chunkFileContent, isGeneratedFile } from "../src/plugins/code.js";

const run = (path: string, src: string, lang: string, maxChars?: number) =>
  chunkFileContent("p", "s", path, src, lang, maxChars);

const named = (chunks: ReturnType<typeof run>) => chunks.filter((c) => c.symbol_name !== "");
const gaps = (chunks: ReturnType<typeof run>) => chunks.filter((c) => c.symbol_name === "");

function bigTs(minChars: number): { src: string; names: string[] } {
  const names: string[] = [];
  let src = "";
  for (let i = 0; src.length < minChars; i++) {
    names.push(`fn${i}`);
    src += `export function fn${i}(a: number): number {\n  return a + ${i};\n}\n\n`;
  }
  return { src, names };
}

describe("big files", () => {
  it("parses TypeScript well over 32 KB with exact symbols", () => {
    const { src, names } = bigTs(40_000);
    expect(src.length).toBeGreaterThan(40_000);
    const chunks = run("big.ts", src, "typescript");
    expect(named(chunks).map((c) => c.symbol_name)).toEqual(names);
  });

  it.each([32_000, 33_500])("works just around the 32,768 boundary (%i)", (n) => {
    const { src, names } = bigTs(n);
    const chunks = run("edge.ts", src, "typescript");
    expect(named(chunks).map((c) => c.symbol_name)).toEqual(names);
  });

  it("parses a boundary-sized file on both sides", () => {
    for (const target of [32_700, 32_800]) {
      let { src } = bigTs(target - 100);
      src = src.padEnd(target, " ");
      const chunks = run("b.ts", src + "\nfunction tail() {}\n", "typescript");
      expect(named(chunks).map((c) => c.symbol_name)).toContain("tail");
    }
  });

  it("parses large C# with class and method symbols", () => {
    let body = "";
    for (let i = 0; i < 700; i++) body += `    public int M${i}(int a)\n    {\n        return a + ${i};\n    }\n`;
    const src = `using System;\nnamespace N\n{\n  public class Big\n  {\n${body}  }\n}\n`;
    expect(src.length).toBeGreaterThan(40_000);
    const chunks = run("Big.cs", src, "csharp");
    const syms = named(chunks).map((c) => c.symbol_name);
    expect(syms).toContain("Big");
    expect(syms).toContain("Big.M0");
    expect(syms).toContain("Big.M699");
  });
});

describe("gap chunks", () => {
  const jsTest = [
    "const assert = require('assert');",
    "describe('thing', () => {",
    "  it('does the unique-marker-alpha', () => {",
    "    assert.ok(true);",
    "  });",
    "});",
    "",
    "function helper() {",
    "  return 1;",
    "}",
    "",
    "describe('other', () => {",
    "  it('unique-marker-beta', () => {});",
    "});",
    "",
  ].join("\n");

  it("keeps describe/it text in empty-symbol chunks and helper as named, with no shared line", () => {
    const chunks = run("t.test.js", jsTest, "javascript");
    const helper = chunks.find((c) => c.symbol_name === "helper")!;
    expect(helper).toBeDefined();
    const g = gaps(chunks);
    expect(g.some((c) => c.content.includes("unique-marker-alpha"))).toBe(true);
    expect(g.some((c) => c.content.includes("unique-marker-beta"))).toBe(true);
    for (const c of g) {
      const overlaps = c.start_line <= helper.end_line && c.end_line >= helper.start_line;
      expect(overlaps).toBe(false);
    }
  });

  it("yields only the function for an import-only gap", () => {
    const src = "import a from 'a';\nimport { b } from 'b';\nexport { a };\nexport * from 'c';\n\nfunction only() {\n  return 1;\n}\n";
    const chunks = run("i.ts", src, "typescript");
    expect(chunks.map((c) => c.symbol_name)).toEqual(["only"]);
  });

  it("yields no gap chunk for C# usings plus a class", () => {
    const src = "using System;\nusing System.Linq;\n\npublic class K\n{\n    public void M() { }\n}\n";
    const chunks = run("K.cs", src, "csharp");
    expect(gaps(chunks)).toEqual([]);
    expect(named(chunks).length).toBeGreaterThan(0);
  });

  it("yields nothing for a comment-only gap", () => {
    const src = "// header comment\n/* block */\n\nfunction f() {\n  return 1;\n}\n// trailing\n";
    const chunks = run("c.ts", src, "typescript");
    expect(chunks.map((c) => c.symbol_name)).toEqual(["f"]);
  });

  it("indexes a top-level const between two functions", () => {
    const src = "function a() {\n  return 1;\n}\n\nconst x = 1;\n\nfunction b() {\n  return 2;\n}\n";
    const chunks = run("x.ts", src, "typescript");
    const g = gaps(chunks);
    expect(g).toHaveLength(1);
    expect(g[0].content).toBe("const x = 1;");
    expect(g[0].start_line).toBe(5);
    expect(named(chunks).map((c) => c.symbol_name)).toEqual(["a", "b"]);
  });

  it("does not change declaration chunk ids when gap code surrounds them", () => {
    const decl = "function stable() {\n  return 42;\n}";
    const plain = run("s.ts", decl + "\n", "typescript");
    const withGaps = run("s.ts", "const before = 1;\n\n" + decl + "\n\nconst after = 2;\n", "typescript");
    const idPlain = plain.find((c) => c.symbol_name === "stable")!.chunk_id;
    const idGap = withGaps.find((c) => c.symbol_name === "stable")!.chunk_id;
    expect(idGap).toBe(idPlain);
    expect(gaps(withGaps).length).toBeGreaterThan(0);
  });

  it("splits a gap larger than the line limit and respects maxChars", () => {
    let src = "function a() {\n  return 1;\n}\n\n";
    for (let i = 0; i < 200; i++) src += `register("item-${i}", { value: ${i}, label: "some label text here" });\n`;
    src += "\nfunction z() {\n  return 2;\n}\n";
    const chunks = run("g.ts", src, "typescript", 1500);
    const g = gaps(chunks);
    expect(g.length).toBeGreaterThan(1);
    for (const c of chunks) expect(c.content.length).toBeLessThanOrEqual(1500);
  });

  it("keeps Python top-level code and leaves the imports before it out", () => {
    const src = "import os\nfrom a import b\n\nCONFIG = {'k': 1}\n\ndef f():\n    return 1\n";
    const chunks = run("m.py", src, "python");
    const g = gaps(chunks);
    expect(g).toHaveLength(1);
    expect(g[0].content).toContain("CONFIG = {'k': 1}");
    expect(g[0].content).not.toContain("import");
    expect(g[0].start_line).toBe(4);
  });

  it("files without declarations still use the sliding window", () => {
    const chunks = run("n.ts", "const a = 1;\nconst b = 2;\n", "typescript");
    expect(chunks).toHaveLength(1);
    expect(chunks[0].symbol_name).toBe("");
  });
});

describe("generated files", () => {
  const body = "export function realFn() {\n  return 1;\n}\n";

  it("detects markers in the first 5 lines and by name", () => {
    expect(isGeneratedFile("a.ts", "// @generated\n" + body)).toBe(true);
    expect(isGeneratedFile("a.cs", "// <auto-generated>\n")).toBe(true);
    expect(isGeneratedFile("a.go", "// Code generated by x. DO NOT EDIT.\n")).toBe(true);
    expect(isGeneratedFile("a.ts", "\n\n\n\n\n// DO NOT EDIT\n")).toBe(false);
    expect(isGeneratedFile("x/Foo.Designer.cs", "class A {}")).toBe(true);
    expect(isGeneratedFile("Foo.g.cs", "class A {}")).toBe(true);
    expect(isGeneratedFile("Foo.g.i.cs", "class A {}")).toBe(true);
    expect(isGeneratedFile("app.min.js", "x")).toBe(true);
    expect(isGeneratedFile("api.generated.ts", "x")).toBe(true);
    expect(isGeneratedFile("api.ts", body)).toBe(false);
  });

  it("uses only sliding-window chunks for a marker file and a named file", () => {
    for (const [path, src, lang] of [
      ["m.ts", "// @generated\n" + body, "typescript"],
      ["Foo.Designer.cs", "public class A\n{\n    void M() { }\n}\n", "csharp"],
    ] as const) {
      const chunks = run(path, src, lang);
      expect(chunks.length).toBeGreaterThan(0);
      expect(chunks.every((c) => c.symbol_name === "")).toBe(true);
    }
  });

  it("applies to Vue too", () => {
    const vue = "<!-- auto-generated -->\n<template><div/></template>\n<script>\nfunction f() {}\n</script>\n";
    expect(run("a.vue", vue, "vue").every((c) => c.symbol_name === "")).toBe(true);
  });
});

describe("Vue line numbers", () => {
  it("slices an oversized declaration from the right lines and numbers a gap correctly", () => {
    const fnLines: string[] = ["function big() {"];
    for (let i = 0; i < 90; i++) fnLines.push(`  const v${i} = ${i};`);
    fnLines.push("}");
    const scriptLines = ["const top = 1;", "", ...fnLines];
    const srcLines = ["<template>", "  <div />", "</template>", "", "<script lang=\"ts\">", ...scriptLines, "</script>", ""];
    const src = srcLines.join("\n");
    const chunks = run("c.vue", src, "vue");

    for (const c of chunks) {
      const real = srcLines.slice(c.start_line - 1, c.end_line).join("\n").trim();
      expect(c.content).toBe(real);
    }
    const big = chunks.filter((c) => c.symbol_name === "big");
    expect(big).toHaveLength(1);
    expect(big[0].start_line).toBe(5 + 3);
    expect(chunks.filter((c) => c.symbol_name === "").length).toBeGreaterThan(1);
    const gap = gaps(chunks).find((c) => c.content === "const top = 1;")!;
    expect(gap.start_line).toBe(6);
  });
});
