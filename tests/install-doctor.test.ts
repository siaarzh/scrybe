import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { join } from "path";
import { dirname as pathDirname, basename as pathBasename } from "path";

// ── Shared path-walk logic (mirrors src/install-doctor.ts findNpxWorkspaceRoot) ──
// We test the walk algorithm by re-implementing it here parameterised on a
// start path, since import.meta.url is static and can't be easily overridden.

function walkForNpxRoot(startFile: string): string | null {
  let current = pathDirname(startFile);
  while (true) {
    const parent = pathDirname(current);
    if (parent === current) return null;
    if (pathBasename(parent) === "_npx") return current;
    current = parent;
  }
}

// ── findNpxWorkspaceRoot path-walk tests ─────────────────────────────────────

describe("findNpxWorkspaceRoot — path walk logic", () => {
  it("npm 10 hoisted: returns _npx child dir", () => {
    // ~/.npm/_npx/<hash>/node_modules/scrybe-cli/dist/index.js
    const fakePath = join("/home", "user", ".npm", "_npx", "abc123hash", "node_modules", "scrybe-cli", "dist", "index.js");
    const result = walkForNpxRoot(fakePath);
    expect(result).toBe(join("/home", "user", ".npm", "_npx", "abc123hash"));
  });

  it("npm 9 nested: outermost _npx child wins", () => {
    // ~/.npm/_npx/<hash>/node_modules/<wrapper>/node_modules/scrybe-cli/dist/index.js
    const fakePath = join("/home", "user", ".npm", "_npx", "abc123hash", "node_modules", "some-wrapper", "node_modules", "scrybe-cli", "dist", "index.js");
    const result = walkForNpxRoot(fakePath);
    expect(result).toBe(join("/home", "user", ".npm", "_npx", "abc123hash"));
  });

  it("global install: returns null (no _npx ancestor)", () => {
    // /usr/lib/node_modules/scrybe-cli/dist/index.js
    const fakePath = join("/usr", "lib", "node_modules", "scrybe-cli", "dist", "index.js");
    const result = walkForNpxRoot(fakePath);
    expect(result).toBeNull();
  });

  it("root traversal terminates without infinite loop", () => {
    // Start from a path just under the root
    const fakePath = join("/", "index.js");
    const result = walkForNpxRoot(fakePath);
    expect(result).toBeNull();
  });
});

// ── detectBrokenInstall ───────────────────────────────────────────────────────

describe("detectBrokenInstall", () => {
  it("returns null when all landmark deps resolve (clean install)", async () => {
    vi.resetModules();
    const { detectBrokenInstall } = await import("../src/install-doctor.js");
    const result = detectBrokenInstall();
    // In a normal dev install all landmark deps are present
    expect(result).toBeNull();
  });

  it("returns {missing} listing missing landmarks when some deps not resolvable", async () => {
    vi.resetModules();
    // Mock node:module so createRequire returns a resolver that throws for specific deps
    vi.doMock("node:module", async () => {
      const actual = await vi.importActual<typeof import("node:module")>("node:module");
      return {
        ...actual,
        createRequire: (_url: string) => {
          // Build a fake require that throws for this landmark dep
          const fakeResolve = (id: string): string => {
            if (id === "@xenova/transformers/package.json" || id === "@xenova/transformers") {
              throw new Error(`Cannot find module '${id}'`);
            }
            // Return a dummy path for all others
            return `/fake/node_modules/${id}`;
          };
          const fakeReq = Object.assign(
            function fakeRequire(_id: string) { return {}; },
            { resolve: fakeResolve, cache: {}, extensions: {}, main: undefined as unknown as NodeModule },
          );
          return fakeReq as NodeRequire;
        },
      };
    });
    const { detectBrokenInstall } = await import("../src/install-doctor.js");
    const result = detectBrokenInstall();
    expect(result).not.toBeNull();
    expect(result!.missing).toContain("@xenova/transformers");
  });
});

// ── formatBrokenInstallText ───────────────────────────────────────────────────

describe("formatBrokenInstallText", () => {
  it("first line is ≤100 chars", async () => {
    vi.resetModules();
    const { formatBrokenInstallText } = await import("../src/install-doctor.js");
    const text = formatBrokenInstallText({ missing: ["sharp"] });
    const firstLine = text.split("\n")[0]!;
    expect(firstLine.length).toBeLessThanOrEqual(100);
  });

  it("first line is a copy-pasteable command (starts with Run:)", async () => {
    vi.resetModules();
    const { formatBrokenInstallText } = await import("../src/install-doctor.js");
    const text = formatBrokenInstallText({ missing: ["sharp", "@lancedb/lancedb"] });
    const firstLine = text.split("\n")[0]!;
    expect(firstLine).toMatch(/^Run:/);
  });

  it("text includes all missing deps", async () => {
    vi.resetModules();
    const { formatBrokenInstallText } = await import("../src/install-doctor.js");
    const text = formatBrokenInstallText({ missing: ["sharp", "tree-sitter", "apache-arrow"] });
    expect(text).toContain("sharp");
    expect(text).toContain("tree-sitter");
    expect(text).toContain("apache-arrow");
  });
});

// ── emitInstallErrorOverMcp ───────────────────────────────────────────────────

describe("emitInstallErrorOverMcp", () => {
  // Captured handlers set during mock setup
  let capturedSetRequestHandler: Array<[unknown, unknown]> = [];
  let serverInstance: {
    setRequestHandler: ReturnType<typeof vi.fn>;
    connect: ReturnType<typeof vi.fn>;
  };

  beforeEach(() => {
    vi.resetModules();
    capturedSetRequestHandler = [];

    // Simulate stdin closing immediately on "end" event
    const originalStdin = process.stdin;
    vi.spyOn(process, "stdin", "get").mockReturnValue({
      ...originalStdin,
      on: vi.fn(function (this: unknown, event: string, cb: () => void) {
        if (event === "end") setTimeout(cb, 5);
        return this;
      }) as unknown as typeof originalStdin.on,
    } as unknown as typeof originalStdin);

    // Mock the MCP SDK — Server must be a real constructor function
    serverInstance = {
      setRequestHandler: vi.fn((schema: unknown, handler: unknown) => {
        capturedSetRequestHandler.push([schema, handler]);
      }),
      connect: vi.fn().mockResolvedValue(undefined),
    };

    vi.doMock("@modelcontextprotocol/sdk/server/index.js", () => ({
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      Server: vi.fn(function (this: typeof serverInstance) {
        Object.assign(this, serverInstance);
      }),
    }));

    vi.doMock("@modelcontextprotocol/sdk/server/stdio.js", () => ({
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      StdioServerTransport: vi.fn(function (this: unknown) {
        // no-op
      }),
    }));

    vi.doMock("@modelcontextprotocol/sdk/types.js", () => ({
      ListToolsRequestSchema: { _tag: "ListTools" },
      CallToolRequestSchema: { _tag: "CallTool" },
    }));
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("registers scrybe_install_incomplete tool with recovery copy in description", async () => {
    const { emitInstallErrorOverMcp, formatBrokenInstallText } = await import("../src/install-doctor.js");

    await emitInstallErrorOverMcp({ missing: ["sharp"] });

    // setRequestHandler called at least twice (list + call)
    expect(serverInstance.setRequestHandler).toHaveBeenCalledTimes(2);

    // First call registers list-tools handler
    const [, listHandler] = capturedSetRequestHandler[0]!;
    const listResult = (listHandler as () => unknown)() as { tools: Array<{ name: string; description: string }> };
    expect(listResult.tools).toHaveLength(1);
    expect(listResult.tools[0]!.name).toBe("scrybe_install_incomplete");

    // Description first line matches formatBrokenInstallText first line
    const expectedFirstLine = formatBrokenInstallText({ missing: ["sharp"] }).split("\n")[0]!;
    expect(listResult.tools[0]!.description.split("\n")[0]).toBe(expectedFirstLine);
  });

  it("tool call returns isError: true", async () => {
    const { emitInstallErrorOverMcp } = await import("../src/install-doctor.js");

    await emitInstallErrorOverMcp({ missing: ["sharp"] });

    // Second registered handler is call-tool
    const [, callHandler] = capturedSetRequestHandler[1]!;
    const callResult = (callHandler as (r: unknown) => unknown)({
      params: { name: "scrybe_install_incomplete", arguments: {} },
    }) as { isError: boolean };
    expect(callResult.isError).toBe(true);
  });

  it("server is named 'scrybe (install incomplete)'", async () => {
    const { emitInstallErrorOverMcp } = await import("../src/install-doctor.js");
    const { Server } = await import("@modelcontextprotocol/sdk/server/index.js");

    await emitInstallErrorOverMcp({ missing: ["sharp"] });

    const ctorCall = (Server as ReturnType<typeof vi.fn>).mock.calls[0]!;
    expect(ctorCall[0]).toMatchObject({ name: "scrybe (install incomplete)" });
  });
});
