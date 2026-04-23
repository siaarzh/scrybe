/**
 * E2E: scrybe init wizard with mocked @clack/prompts.
 * Verifies: registry entries written, .scrybeignore created, MCP entry added.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { mkdtempSync, rmSync, mkdirSync, writeFileSync, readFileSync, existsSync } from "fs";
import { join } from "path";
import { tmpdir } from "os";
import { execSync } from "child_process";

let dataDir = "";
let repoDir = "";
let homeDir = "";

function makeFixtureRepo(dir: string): void {
  mkdirSync(dir, { recursive: true });
  execSync("git init", { cwd: dir, stdio: "ignore" });
  execSync("git config user.email test@test.com", { cwd: dir, stdio: "ignore" });
  execSync("git config user.name Test", { cwd: dir, stdio: "ignore" });
  writeFileSync(join(dir, "index.ts"), "export const greet = () => 'hello';");
  writeFileSync(join(dir, ".gitignore"), "node_modules\n*.log\n");
  execSync("git add -A", { cwd: dir, stdio: "ignore" });
  execSync('git commit -m "init"', { cwd: dir, stdio: "ignore" });
}

// Saved originals to restore after each test
let savedEnv: Record<string, string | undefined> = {};
const CLEAR_VARS = ["EMBEDDING_API_KEY", "OPENAI_API_KEY", "EMBEDDING_BASE_URL", "EMBEDDING_MODEL", "EMBEDDING_DIMENSIONS"];

beforeEach(() => {
  dataDir = mkdtempSync(join(tmpdir(), "scrybe-e2e-init-"));
  repoDir = mkdtempSync(join(tmpdir(), "scrybe-e2e-repo-"));
  homeDir = mkdtempSync(join(tmpdir(), "scrybe-e2e-home-"));
  makeFixtureRepo(repoDir);
  vi.resetModules();
  process.env["SCRYBE_DATA_DIR"] = dataDir;
  // Clear provider env vars — set to "" so config.ts's .env loader won't refill them
  savedEnv = {};
  for (const k of CLEAR_VARS) {
    savedEnv[k] = process.env[k];
    process.env[k] = "";
  }
});

afterEach(() => {
  vi.restoreAllMocks();
  rmSync(dataDir, { recursive: true, force: true });
  rmSync(repoDir, { recursive: true, force: true });
  rmSync(homeDir, { recursive: true, force: true });
  delete process.env["SCRYBE_DATA_DIR"];
  // Restore provider env vars
  for (const k of CLEAR_VARS) {
    if (savedEnv[k] !== undefined) process.env[k] = savedEnv[k]!;
    else delete process.env[k];
  }
});

async function runWizardMocked({
  providerValue = "voyage",
  apiKey = "test-key",
  validateOk = true,
  selectedRepos = [] as string[],
  addManual = false,
  mcpConfirm = false,
  doIndex = false,
  useExternalProvider = false, // false = local path (new default); true = API provider path
}: {
  providerValue?: string;
  apiKey?: string;
  validateOk?: boolean;
  selectedRepos?: string[];
  addManual?: boolean;
  mcpConfirm?: boolean;
  doIndex?: boolean;
  useExternalProvider?: boolean;
} = {}): Promise<void> {
  // Mock @clack/prompts.
  // Confirm sequence: [useExternal?, addManual?, mcpConfirm?, doIndex?]
  vi.doMock("@clack/prompts", () => ({
    intro: vi.fn(),
    outro: vi.fn(),
    cancel: vi.fn(),
    log: { info: vi.fn(), success: vi.fn(), warn: vi.fn(), error: vi.fn(), message: vi.fn() },
    isCancel: vi.fn(() => false),
    spinner: () => ({ start: vi.fn(), stop: vi.fn() }),
    select: vi.fn().mockResolvedValueOnce(providerValue),
    password: vi.fn().mockResolvedValueOnce(apiKey),
    multiselect: vi.fn().mockResolvedValueOnce(selectedRepos),
    confirm: vi.fn()
      .mockResolvedValueOnce(useExternalProvider) // "Use an external provider?" Step 1
      .mockResolvedValueOnce(addManual)            // "Add repo manually?"
      .mockResolvedValueOnce(mcpConfirm)           // MCP confirm (may not be called)
      .mockResolvedValueOnce(doIndex),             // "Index now?"
    text: vi.fn(),
  }));

  // Mock validateProvider + validateLocal
  vi.doMock("../../src/onboarding/validate-provider.js", () => ({
    validateProvider: vi.fn().mockResolvedValue(
      validateOk
        ? { ok: true, dimensions: 1024, model: "voyage-code-3" }
        : { ok: false, errorType: "auth", message: "Invalid API key" }
    ),
    validateLocal: vi.fn().mockResolvedValue(
      validateOk
        ? { ok: true, dimensions: 384, model: "Xenova/multilingual-e5-small", coldStartMs: 200 }
        : { ok: false, errorType: "other", message: "Model not cached" }
    ),
  }));

  // Mock discoverRepos to return our test repo
  vi.doMock("../../src/onboarding/repo-discovery.js", () => ({
    discoverRepos: vi.fn().mockResolvedValue({
      repos: [{ path: repoDir, isGitRepo: true, alreadyRegistered: false, primaryLanguage: "typescript", fileCount: 1 }],
      hitLimit: null,
      scannedRoots: [repoDir],
    }),
  }));

  // Mock MCP detection to return fake home paths
  vi.doMock("../../src/onboarding/mcp-config.js", () => ({
    detectMcpConfigs: vi.fn().mockReturnValue([]),
    proposeScrybeEntry: vi.fn().mockReturnValue({ command: "npx", args: ["-y", "scrybe-cli", "mcp"] }),
    computeDiff: vi.fn().mockReturnValue({ action: "skip", diff: "", file: {}, existing: null, proposed: {} }),
    applyMcpMerge: vi.fn().mockResolvedValue(undefined),
  }));

  // Mock indexProject to avoid real embedding calls
  vi.doMock("../../src/indexer.js", () => ({
    indexProject: vi.fn().mockResolvedValue([{ chunks_indexed: 0, files_scanned: 0, files_reindexed: 0, files_removed: 0 }]),
  }));

  const { runWizard } = await import("../../src/onboarding/wizard.js");
  await runWizard({ skipIndex: !doIndex });
}

describe("wizard — provider skip when already configured", () => {
  it("skips provider prompts when EMBEDDING_API_KEY is set", async () => {
    process.env["EMBEDDING_API_KEY"] = "existing-key";
    process.env["EMBEDDING_BASE_URL"] = "https://api.voyageai.com/v1";
    process.env["EMBEDDING_MODEL"] = "voyage-code-3";

    const selectMock = vi.fn();
    vi.doMock("@clack/prompts", () => ({
      intro: vi.fn(), outro: vi.fn(), cancel: vi.fn(),
      log: { info: vi.fn(), success: vi.fn(), warn: vi.fn(), error: vi.fn(), message: vi.fn() },
      isCancel: vi.fn(() => false),
      spinner: () => ({ start: vi.fn(), stop: vi.fn() }),
      select: selectMock,
      password: vi.fn(),
      multiselect: vi.fn().mockResolvedValueOnce([]),
      confirm: vi.fn().mockResolvedValue(false),
      text: vi.fn(),
    }));
    vi.doMock("../../src/onboarding/repo-discovery.js", () => ({
      discoverRepos: vi.fn().mockResolvedValue({ repos: [], hitLimit: null, scannedRoots: [] }),
    }));
    vi.doMock("../../src/onboarding/mcp-config.js", () => ({
      detectMcpConfigs: vi.fn().mockReturnValue([]),
      proposeScrybeEntry: vi.fn().mockReturnValue({ command: "npx", args: [] }),
      computeDiff: vi.fn().mockReturnValue({ action: "skip", diff: "", file: {}, existing: null, proposed: {} }),
      applyMcpMerge: vi.fn().mockResolvedValue(undefined),
    }));

    const { runWizard } = await import("../../src/onboarding/wizard.js");
    await runWizard({ skipIndex: true });

    // Provider picker select should NOT have been called
    expect(selectMock).not.toHaveBeenCalled();

    delete process.env["EMBEDDING_API_KEY"];
    delete process.env["EMBEDDING_BASE_URL"];
    delete process.env["EMBEDDING_MODEL"];
  });
});

describe("wizard — registry side effects", () => {
  it("registers selected repo in projects.json", async () => {
    await runWizardMocked({ selectedRepos: [repoDir] });
    const projectsPath = join(dataDir, "projects.json");
    expect(existsSync(projectsPath)).toBe(true);
    const projects = JSON.parse(readFileSync(projectsPath, "utf8")) as any[];
    const hasRepo = projects.some((p) =>
      p.sources?.some((s: any) => s.source_config?.root_path === repoDir)
    );
    expect(hasRepo).toBe(true);
  });

  it("generates .scrybeignore for selected repo", async () => {
    await runWizardMocked({ selectedRepos: [repoDir] });
    expect(existsSync(join(repoDir, ".scrybeignore"))).toBe(true);
    const content = readFileSync(join(repoDir, ".scrybeignore"), "utf8");
    expect(content).toContain("node_modules/");
  });

  it("merges .gitignore patterns into .scrybeignore", async () => {
    await runWizardMocked({ selectedRepos: [repoDir] });
    const content = readFileSync(join(repoDir, ".scrybeignore"), "utf8");
    expect(content).toContain("*.log"); // from fixture .gitignore
  });

  it("does not overwrite existing .scrybeignore", async () => {
    const existing = "# my rules\nfoo/\n";
    writeFileSync(join(repoDir, ".scrybeignore"), existing);
    await runWizardMocked({ selectedRepos: [repoDir] });
    expect(readFileSync(join(repoDir, ".scrybeignore"), "utf8")).toBe(existing);
  });

  it("skips repos not selected", async () => {
    await runWizardMocked({ selectedRepos: [] });
    const projectsPath = join(dataDir, "projects.json");
    if (existsSync(projectsPath)) {
      const projects = JSON.parse(readFileSync(projectsPath, "utf8")) as any[];
      const hasRepo = projects.some((p) =>
        p.sources?.some((s: any) => s.source_config?.root_path === repoDir)
      );
      expect(hasRepo).toBe(false);
    }
    // .scrybeignore should not be created
    expect(existsSync(join(repoDir, ".scrybeignore"))).toBe(false);
  });
});

describe("wizard — credentials written", () => {
  it("writes SCRYBE_LOCAL_EMBEDDER to DATA_DIR/.env on local path", async () => {
    await runWizardMocked(); // default: local path
    const envPath = join(dataDir, ".env");
    expect(existsSync(envPath)).toBe(true);
    const content = readFileSync(envPath, "utf8");
    expect(content).toContain("SCRYBE_LOCAL_EMBEDDER=");
    expect(content).toContain("EMBEDDING_DIMENSIONS=384");
  });

  it("writes API key to DATA_DIR/.env on external provider path", async () => {
    await runWizardMocked({ useExternalProvider: true, apiKey: "sk-test-xyz" });
    const envPath = join(dataDir, ".env");
    expect(existsSync(envPath)).toBe(true);
    const content = readFileSync(envPath, "utf8");
    expect(content).toContain("EMBEDDING_API_KEY=sk-test-xyz");
  });
});
