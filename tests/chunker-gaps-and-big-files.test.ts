import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, readFileSync, rmSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
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

  const bigCs = (() => {
    let methods = "";
    while (methods.length < 33_000) methods += `    void M${methods.length}() { }\n`;
    return `public class A\n{\n${methods}}\n`;
  })();

  it("uses only sliding-window chunks for a marker file and a named file of 32,768 chars and over", () => {
    for (const [path, src, lang] of [
      ["m.ts", "// @generated\n" + bigTs(33_000).src, "typescript"],
      ["Foo.Designer.cs", bigCs, "csharp"],
    ] as const) {
      const chunks = run(path, src, lang);
      expect(chunks.length).toBeGreaterThan(0);
      expect(chunks.every((c) => c.symbol_name === "")).toBe(true);
    }
  });

  it("keeps symbols in a small generated file", () => {
    expect(named(run("m.ts", "// @generated\n" + body, "typescript")).map((c) => c.symbol_name)).toEqual(["realFn"]);
    const cs = "public class A\n{\n    void M() { }\n}\n";
    expect(named(run("Foo.g.cs", cs, "csharp")).map((c) => c.symbol_name)).toEqual(["A", "A.M"]);
  });

  it("switches at exactly 32,768 chars", () => {
    const head = "// @generated\n" + body;
    const under = head.padEnd(32_767, " ");
    const at = head.padEnd(32_768, " ");
    expect(named(run("m.ts", under, "typescript")).length).toBeGreaterThan(0);
    expect(named(run("m.ts", at, "typescript"))).toEqual([]);
  });

  it("applies to Vue by the size of its script block", () => {
    const small = "<!-- auto-generated -->\n<template><div/></template>\n<script>\nfunction f() {}\n</script>\n";
    expect(named(run("a.vue", small, "vue")).map((c) => c.symbol_name)).toEqual(["f"]);
    const big = `<!-- auto-generated -->\n<template><div/></template>\n<script>\n${bigTs(33_000).src}</script>\n`;
    expect(run("a.vue", big, "vue").every((c) => c.symbol_name === "")).toBe(true);
  });
});

describe("very deep expressions", () => {
  let dir = "";
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "scrybe-chunker-"));
    process.env["SCRYBE_DAEMON_LOG_PATH"] = join(dir, "log.jsonl");
  });
  afterEach(() => {
    delete process.env["SCRYBE_DAEMON_LOG_PATH"];
    rmSync(dir, { recursive: true, force: true });
  });

  it.each([
    ["a 5,000-term sum", `const total = ${Array(5_000).fill("1").join("+")};\n`],
    ["a 5,000-link .then chain", `p${".then(f)".repeat(5_000)};\n`],
  ])("%s falls back to the sliding window with a parse_failed event", (_name, src) => {
    const chunks = run("deep.ts", src + "function after() {}\n", "typescript");
    expect(chunks.length).toBeGreaterThan(0);
    expect(chunks.every((c) => c.symbol_name === "")).toBe(true);
    const events = readFileSync(process.env["SCRYBE_DAEMON_LOG_PATH"]!, "utf8").trim().split("\n").map((l) => JSON.parse(l));
    expect(events.some((e) => e.event === "chunker.parse_failed" && e.path === "deep.ts")).toBe(true);
  });
});

describe("leftovers that are not code", () => {
  const bodies = (path: string, src: string, lang: string) => gaps(run(path, src, lang)).map((c) => c.content);
  const fn = "function f() {\n  return 1;\n}\n";
  // C function chunks carry no symbol name, so compare every chunk's content.
  const cFn = "int f(void) {\n  return 1;\n}\n";
  const cChunks = (path: string, src: string, lang: string) => run(path, src, lang).map((c) => c.content);

  it("treats require declarations as imports, but not other values", () => {
    for (const lang of ["javascript", "typescript"]) {
      expect(bodies("a.js", `const a = require('a');\nvar b = require('b');\nlet c = require('c'), { d } = require('d');\n\n${fn}`, lang)).toEqual([]);
    }
    expect(bodies("a.ts", `import x = require('x');\n\n${fn}`, "typescript")).toEqual([]);
    expect(bodies("a.js", `const a = require('a'), b = 2;\n\n${fn}`, "javascript")).toHaveLength(1);
    expect(bodies("a.js", `const e = require('e').f;\n\n${fn}`, "javascript")).toHaveLength(1);
    expect(bodies("a.js", `const g = load('g');\n\n${fn}`, "javascript")).toHaveLength(1);
  });

  it("treats Ruby require and require_relative as imports, but not a method on a receiver", () => {
    const def = "def f\n  1\nend\n";
    expect(bodies("a.rb", `require 'a'\nrequire_relative 'b'\nrequire('c')\n\n${def}`, "ruby")).toEqual([]);
    expect(bodies("a.rb", `foo.require 'x'\n\n${def}`, "ruby")).toHaveLength(1);
    expect(bodies("a.rb", `puts 'x'\n\n${def}`, "ruby")).toHaveLength(1);
  });

  it.each(["c", "cpp"])("drops %s pragmas and valueless defines, keeps #define with a value", (lang) => {
    expect(cChunks("a.c", `#pragma once\n#define GUARD\n#include <x.h>\n\n${cFn}`, lang)).toEqual([cFn.trim()]);
    expect(cChunks("a.c", `#define MAX 10\n\n${cFn}`, lang)).toEqual([cFn.trim(), "#define MAX 10"]);
  });

  it.each(["c", "cpp"])("yields nothing for a %s #ifndef of guards and includes, or around a function", (lang) => {
    const guard = "#ifndef A_H\n#define A_H\n#pragma once\n#include <x.h>\n#else\n#define B\n#endif\n\n";
    expect(cChunks("a.h", guard + cFn, lang)).toEqual([cFn.trim()]);
    expect(cChunks("a.h", `#ifndef A_H\n#define A_H\n#include <x.h>\n\n${cFn}\n#endif\n`, lang)).toEqual([cFn.trim()]);
    expect(cChunks("a.h", `#ifndef A_H\n#define MAX 10\n#endif\n\n${cFn}`, lang)).toHaveLength(2);
  });

  it("drops a C++ template header left beside a declaration", () => {
    expect(bodies("a.cpp", "template <typename T>\nclass X\n{\n};\n", "cpp")).toEqual([]);
    expect(bodies("a.cpp", "template <typename T>\nT g()\n{\n  return T();\n}\n", "cpp")).toEqual([]);
  });

  it.each([
    ["python", "a.py", "@dataclass\nclass X:\n    pass\n", ["X"]],
    ["python", "a.py", "@app.route('/')\n@cached\ndef view():\n    return 1\n", ["view"]],
    ["rust", "a.rs", "#![allow(dead_code)]\n\n#[test]\nfn x() {}\n", ["x"]],
    ["typescript", "a.ts", "@Component({ selector: 'x' })\nexport class C {}\n", ["C"]],
    ["typescript", "a.ts", "@Dec\nclass D {}\n", ["D"]],
    ["java", "A.java", "@Foo\npackage x;\n\n@Bar\nclass A {}\n", ["A"]],
    ["csharp", "A.cs", "[assembly: Foo(1)]\n\n[Attr]\nclass A\n{\n}\n", ["A"]],
  ])("no chunk holds only a decorator or attribute (%s %s)", (lang, path, src, symbols) => {
    const chunks = run(path as string, src as string, lang as string);
    expect(gaps(chunks)).toEqual([]);
    expect(named(chunks).map((c) => c.symbol_name)).toEqual(symbols);
  });

  it("keeps declaration chunk ids when a decorator goes away", () => {
    const withoutDecorator = "class X:\n    pass\n";
    const plain = named(run("a.py", withoutDecorator, "python"))[0];
    const decorated = named(run("a.py", `@dataclass\n${withoutDecorator}`, "python"))[0];
    expect(decorated.content).toBe(plain.content);
    expect(decorated.chunk_id).toBe(plain.chunk_id);
  });
});

describe("noise inside a gap", () => {
  const contents = (path: string, src: string, lang: string) => run(path, src, lang).map((c) => c.content);
  const gapContents = (path: string, src: string, lang: string) => gaps(run(path, src, lang)).map((c) => c.content);
  const fn = "function f() {\n  return 1;\n}\n";
  const cFn = "int f(void) {\n  return 1;\n}\n";

  it("C#: directives, usings and a file-scoped namespace leave only the class", () => {
    const src = "#nullable enable\n\nusing System;\nusing System.Linq;\n\nnamespace Foo.Bar;\n\npublic class K {}";
    expect(contents("K.cs", src, "csharp")).toEqual(["public class K {}"]);
  });

  it("TS: imports below real code are cut out, and vi.mock and const survive", () => {
    const src = `import { vi } from 'vitest';\n// mock first\nvi.mock('./x');\nimport { a } from './x';\nimport { b } from './y';\nconst T = 1;\n\n${fn}`;
    expect(gapContents("a.test.ts", src, "typescript")).toEqual(["vi.mock('./x');", "const T = 1;"]);
  });

  it("TS: comments and an import between two consts split them into two chunks", () => {
    const chunks = gaps(run("b.ts", `const x = 1;\n// a comment\n// another\nimport c from 'c';\nconst y = 2;\n\n${fn}`, "typescript"));
    expect(chunks.map((c) => [c.content, c.start_line, c.end_line])).toEqual([["const x = 1;", 1, 1], ["const y = 2;", 5, 5]]);
  });

  it("the same split happens beside a declaration", () => {
    const src = `const x = 1;\n// note\nconst y = 2;\n\n${fn}`;
    expect(gapContents("b.ts", src, "typescript")).toEqual(["const x = 1;", "const y = 2;"]);
  });

  it("blank lines between kept nodes stay in the run; regions never start or end on one", () => {
    const chunks = gaps(run("b.ts", `\n\nconst x = 1;\n\n\nconst y = 2;\n\n\n${fn}`, "typescript"));
    expect(chunks.map((c) => [c.content, c.start_line, c.end_line])).toEqual([["const x = 1;\n\n\nconst y = 2;", 3, 6]]);
  });

  it("a noise node sharing a line with kept code stays with it", () => {
    expect(gapContents("b.ts", `const x = 1; // why\n// alone\nconst y = 2;\n\n${fn}`, "typescript")).toEqual(["const x = 1; // why", "const y = 2;"]);
  });

  it("a comment nested inside a kept node stays", () => {
    const src = "describe('a', () => {\n  // nested note\n  it('b', () => {});\n});\n";
    expect(contents("a.test.ts", src, "typescript")).toEqual([src.trim()]);
  });

  it("a file with nothing but noise still gets its text window", () => {
    expect(contents("i.ts", "import a from 'a';\n// note\n", "typescript")).toEqual(["import a from 'a';\n// note"]);
  });

  it("a Vue script with no declarations keeps its whole-file window, template included", () => {
    const src = "<template><div>unique-template-text</div></template>\n<script>\nimport a from 'a';\nconst b = 1;\n</script>\n";
    expect(contents("a.vue", src, "vue")).toEqual([src.trim()]);
  });

  it("counts rows by newline, so a Unicode line separator does not shift a gap", () => {
    const src = `const s = "a${String.fromCharCode(0x2028)}b";\nimport c from 'c';\nconst y = 2;\n\n${fn}`;
    const g = gaps(run("u.ts", src, "typescript"));
    expect(g.map((c) => [c.start_line, c.content.split("\n").length])).toEqual([[1, 1], [3, 1]]);
    expect(g[1].content).toBe("const y = 2;");
  });

  it.each([
    ["csharp", "A.cs", "#region R\n#pragma warning disable CS1\n#define X\n#undef Y\n#endregion\nclass A\n{\n}\n", "class A\n{\n}"],
    ["csharp", "A.cs", "#if DEBUG\nusing A;\n#elif B\nusing C;\n#endif\nclass A\n{\n}\n", "class A\n{\n}"],
    ["csharp", "A.cs", "namespace Empty { }\nnamespace Only { using Z; }\nclass A\n{\n}\n", "class A\n{\n}"],
    ["typescript", "a.ts", `#!/usr/bin/env node\n'use strict';\n;\n${fn}`, fn.trim()],
    ["typescript", "a.ts", `export default someIdentifier;\n${fn}`, fn.trim()],
    ["typescript", "a.ts", `export = foo;\nexport as namespace Foo;\ndeclare module 'x';\nnamespace Empty {}\n${fn}`, fn.trim()],
    ["typescript", "a.ts", "declare module 'y' {\n  function g() {}\n}\n", "function g() {}"],
    ["javascript", "a.js", `"use strict";\n${fn};\n`, fn.trim()],
    ["python", "a.py", '"""Module doc."""\n"stray"\npass\ndef f():\n    return 1\n', "def f():\n    return 1"],
    ["python", "a.py", "if TYPE_CHECKING:\n    import a\ntry:\n    import b\nexcept ImportError:\n    pass\ndef f():\n    return 1\n", "def f():\n    return 1"],
    ["rust", "a.rs", "mod foo;\npub mod bar;\npub(crate) mod baz;\nmod empty {}\nfn f() {}\n", "fn f() {}"],
    ["cpp", "a.cpp", "using namespace std;\nusing std::string;\nnamespace al = std::chrono;\nextern \"C\" {\n#include <y.h>\n}\nint f() { return 1; }\n", "int f() { return 1; }"],
    ["c", "a.c", `#if defined(A) && B\n#include <y.h>\n#elif C\n#define D\n#else\n#include <z.h>\n#endif\n${cFn}`, cFn.trim()],
    ["c", "a.c", "#if ON\nint f(void) { return 1; }\n#endif\n", "int f(void) { return 1; }"],
    ["ruby", "a.rb", "#!/usr/bin/env ruby\ndef f\n  1\nend\n__END__\ndata\n", "def f\n  1\nend"],
  ])("leaves only the declaration (%s %s)", (lang, path, src, decl) => {
    expect(contents(path, src, lang)).toEqual([decl]);
  });

  it.each([
    ["rust", "a.rs", "pub mod inner {\n    use x::y;\n    fn g() {}\n}\n", "fn g() {}"],
    ["cpp", "a.cpp", "namespace a::b {\n  void g() {}\n}\n", "void g() {}"],
    ["cpp", "a.cpp", "extern \"C\" {\n  void g() {}\n}\n", "void g() {}"],
    ["csharp", "A.cs", "namespace A.B\n{\n    #region X\n    class K\n    {\n    }\n    #endregion\n}\n", "class K\n    {\n    }"],
  ])("a container header leaves nothing behind (%s %s)", (lang, path, src, decl) => {
    expect(contents(path, src, lang)).toEqual([decl]);
  });

  it.each([
    ["typescript", "const T = 1;"],
    ["typescript", "vi.mock('./x');"],
    ["typescript", "describe('x', () => {\n  it('y', () => {});\n});"],
    ["javascript", "module.exports = { a: 1 };"],
    ["typescript", "export default { a: 1 };"],
    ["typescript", "export default a.b;"],
    ["python", 'if __name__ == "__main__":\n    main()'],
    ["python", "try:\n    import a\nexcept ImportError:\n    a = None"],
    ["c", "#define MAX 10"],
    ["cpp", "#define MAX(a, b) (a)"],
    ["cpp", "using I = int;"],
    ["csharp", "public enum E { A }"],
    ["csharp", "namespace N { public enum E { A } }"],
    ["rust", "mod m { const K: u32 = 1; }"],
    ["go", "const K = 1"],
    ["ruby", "puts 'hi'"],
  ])("real code survives beside a declaration and alone (%s: %s)", (lang, code) => {
    const decl = { c: cFn, cpp: cFn, python: "def f():\n    return 1\n", go: "func f() {}\n", rust: "fn f() {}\n", ruby: "def f\n  1\nend\n", csharp: "class A\n{\n}\n" }[lang] ?? fn;
    const path = `a.${lang}`;
    expect(contents(path, `${decl}\n${code}\n`, lang)).toContain(code);
    expect(contents(path, `${code}\n`, lang)).toEqual([code]);
  });

  it("does not change declaration chunks: same content, same ids", () => {
    const decl = "public class K\n{\n    public void M() { }\n}";
    const plain = run("K.cs", `${decl}\n`, "csharp");
    const noisy = run("K.cs", `#nullable enable\n\nusing System;\n\nnamespace Foo.Bar;\n\n${decl}\n`, "csharp");
    expect(noisy.map((c) => [c.symbol_name, c.content, c.chunk_id])).toEqual(plain.map((c) => [c.symbol_name, c.content, c.chunk_id]));
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
