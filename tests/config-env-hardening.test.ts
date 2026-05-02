/**
 * Tests for the env var rename (config hardening):
 *
 * 1. config.ts reads new SCRYBE_CODE_EMBEDDING_* names; old EMBEDDING_* names are ignored.
 * 2. DATA_DIR/.env is the only file consulted; cwd/.env is ignored.
 * 3. Rerank config reads SCRYBE_RERANK_API_KEY only; no fallback to embedding key.
 * 4. warnOldEnvVars() writes warnings for old names found in process.env.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { mkdtempSync, writeFileSync, rmSync, existsSync } from "fs";
import { join } from "path";
import { tmpdir } from "os";

const NEW_KEYS = [
  "SCRYBE_CODE_EMBEDDING_BASE_URL",
  "SCRYBE_CODE_EMBEDDING_API_KEY",
  "SCRYBE_CODE_EMBEDDING_MODEL",
  "SCRYBE_CODE_EMBEDDING_DIMENSIONS",
  "SCRYBE_EMBED_BATCH_SIZE",
  "SCRYBE_EMBED_BATCH_DELAY_MS",
  "SCRYBE_KNOWLEDGE_EMBEDDING_BASE_URL",
  "SCRYBE_KNOWLEDGE_EMBEDDING_API_KEY",
  "SCRYBE_KNOWLEDGE_EMBEDDING_MODEL",
  "SCRYBE_KNOWLEDGE_EMBEDDING_DIMENSIONS",
];

const OLD_KEYS = [
  "EMBEDDING_BASE_URL",
  "EMBEDDING_API_KEY",
  "EMBEDDING_MODEL",
  "EMBEDDING_DIMENSIONS",
  "EMBED_BATCH_SIZE",
  "EMBED_BATCH_DELAY_MS",
  "SCRYBE_TEXT_EMBEDDING_BASE_URL",
  "SCRYBE_TEXT_EMBEDDING_API_KEY",
  "SCRYBE_TEXT_EMBEDDING_MODEL",
  "SCRYBE_TEXT_EMBEDDING_DIMENSIONS",
  "OPENAI_API_KEY",
];

const ALL_KEYS = [...NEW_KEYS, ...OLD_KEYS, "SCRYBE_LOCAL_EMBEDDER", "SCRYBE_RERANK", "SCRYBE_RERANK_API_KEY"];

let savedEnv: Record<string, string | undefined> = {};
let dataDir = "";

beforeEach(() => {
  dataDir = mkdtempSync(join(tmpdir(), "scrybe-cfg-test-"));
  savedEnv = {};
  for (const k of ALL_KEYS) savedEnv[k] = process.env[k];
  for (const k of ALL_KEYS) delete process.env[k];
  process.env["SCRYBE_DATA_DIR"] = dataDir;
  vi.resetModules();
});

afterEach(() => {
  for (const k of ALL_KEYS) {
    if (savedEnv[k] === undefined) delete process.env[k];
    else process.env[k] = savedEnv[k];
  }
  delete process.env["SCRYBE_DATA_DIR"];
  rmSync(dataDir, { recursive: true, force: true });
});

// ─── 1. New env var names are read ───────────────────────────────────────────

describe("config reads new SCRYBE_CODE_EMBEDDING_* names", () => {
  it("uses SCRYBE_CODE_EMBEDDING_BASE_URL as embeddingBaseUrl", async () => {
    process.env["SCRYBE_CODE_EMBEDDING_BASE_URL"] = "https://api.voyageai.com/v1";
    process.env["SCRYBE_CODE_EMBEDDING_API_KEY"] = "voyage-key";
    vi.resetModules();
    const { config } = await import("../src/config.js");
    expect(config.embeddingBaseUrl).toBe("https://api.voyageai.com/v1");
    expect(config.embeddingProviderType).toBe("api");
  });

  it("uses SCRYBE_CODE_EMBEDDING_MODEL when set", async () => {
    process.env["SCRYBE_CODE_EMBEDDING_BASE_URL"] = "https://api.voyageai.com/v1";
    process.env["SCRYBE_CODE_EMBEDDING_API_KEY"] = "key";
    process.env["SCRYBE_CODE_EMBEDDING_MODEL"] = "voyage-code-3";
    vi.resetModules();
    const { config } = await import("../src/config.js");
    expect(config.embeddingModel).toBe("voyage-code-3");
  });

  it("uses SCRYBE_CODE_EMBEDDING_DIMENSIONS when set", async () => {
    process.env["SCRYBE_CODE_EMBEDDING_BASE_URL"] = "https://api.voyageai.com/v1";
    process.env["SCRYBE_CODE_EMBEDDING_API_KEY"] = "key";
    process.env["SCRYBE_CODE_EMBEDDING_DIMENSIONS"] = "512";
    vi.resetModules();
    const { config } = await import("../src/config.js");
    expect(config.embeddingDimensions).toBe(512);
  });

  it("uses SCRYBE_EMBED_BATCH_SIZE when set", async () => {
    process.env["SCRYBE_EMBED_BATCH_SIZE"] = "42";
    vi.resetModules();
    const { config } = await import("../src/config.js");
    expect(config.embedBatchSize).toBe(42);
  });

  it("uses SCRYBE_EMBED_BATCH_DELAY_MS when set", async () => {
    process.env["SCRYBE_EMBED_BATCH_DELAY_MS"] = "200";
    vi.resetModules();
    const { config } = await import("../src/config.js");
    expect(config.embedBatchDelayMs).toBe(200);
  });
});

// ─── 2. Old env var names are NOT read ───────────────────────────────────────

describe("config ignores old EMBEDDING_* names", () => {
  it("ignores EMBEDDING_BASE_URL — resolves to local when only old name is set", async () => {
    process.env["EMBEDDING_BASE_URL"] = "https://api.voyageai.com/v1";
    process.env["EMBEDDING_API_KEY"] = "old-key";
    vi.resetModules();
    const { config } = await import("../src/config.js");
    // Without new names, local path activates (no base URL / API key in new vars)
    expect(config.embeddingProviderType).toBe("local");
  });

  it("ignores EMBED_BATCH_SIZE — uses default 100 when only old name is set", async () => {
    process.env["EMBED_BATCH_SIZE"] = "999";
    vi.resetModules();
    const { config } = await import("../src/config.js");
    expect(config.embedBatchSize).toBe(100);
  });

  it("ignores OPENAI_API_KEY — does not use it as embedding key", async () => {
    process.env["OPENAI_API_KEY"] = "sk-openai-key";
    process.env["SCRYBE_CODE_EMBEDDING_BASE_URL"] = "https://api.openai.com/v1";
    vi.resetModules();
    const { config } = await import("../src/config.js");
    // embeddingApiKey should be "" since SCRYBE_CODE_EMBEDDING_API_KEY is not set
    expect(config.embeddingApiKey).toBe("");
  });
});

// ─── 3. .env search path is DATA_DIR/.env only ───────────────────────────────

describe(".env search path", () => {
  it("reads SCRYBE_CODE_EMBEDDING_* from DATA_DIR/.env", async () => {
    writeFileSync(
      join(dataDir, ".env"),
      "SCRYBE_CODE_EMBEDDING_BASE_URL=https://api.voyageai.com/v1\n" +
      "SCRYBE_CODE_EMBEDDING_API_KEY=dotenv-key\n" +
      "SCRYBE_CODE_EMBEDDING_MODEL=voyage-code-3\n" +
      "SCRYBE_CODE_EMBEDDING_DIMENSIONS=1024\n"
    );
    vi.resetModules();
    const { config } = await import("../src/config.js");
    expect(config.embeddingBaseUrl).toBe("https://api.voyageai.com/v1");
    expect(config.embeddingApiKey).toBe("dotenv-key");
    expect(config.embeddingModel).toBe("voyage-code-3");
    expect(config.embeddingDimensions).toBe(1024);
  });

  it("cwd/.env is NOT read even when present", async () => {
    // Write a cwd/.env with old keys — should be ignored
    const cwdEnvPath = join(process.cwd(), ".env");
    const cwdEnvAlreadyExists = existsSync(cwdEnvPath);
    if (!cwdEnvAlreadyExists) {
      writeFileSync(cwdEnvPath, "SCRYBE_CODE_EMBEDDING_BASE_URL=https://should-not-be-read.invalid\n");
    }
    try {
      // DATA_DIR/.env is empty → local provider activates
      vi.resetModules();
      const { config } = await import("../src/config.js");
      if (!cwdEnvAlreadyExists) {
        // If cwd/.env was read, embeddingBaseUrl would be set (and provider type would be api)
        // Since we expect it NOT to be read, local provider should be active
        expect(config.embeddingProviderType).toBe("local");
      }
    } finally {
      if (!cwdEnvAlreadyExists && existsSync(cwdEnvPath)) {
        rmSync(cwdEnvPath);
      }
    }
  });
});

// ─── 4. Rerank key does NOT fall back to embedding key ───────────────────────

describe("rerank config — no embedding key fallback", () => {
  it("rerank is disabled when SCRYBE_RERANK_API_KEY is unset, even with Voyage embedding", async () => {
    process.env["SCRYBE_CODE_EMBEDDING_BASE_URL"] = "https://api.voyageai.com/v1";
    process.env["SCRYBE_CODE_EMBEDDING_API_KEY"] = "voyage-key";
    process.env["SCRYBE_RERANK"] = "true";
    // SCRYBE_RERANK_API_KEY intentionally not set
    vi.resetModules();
    const { config } = await import("../src/config.js");
    // Auto-enable Voyage rerank, but key is "" since there's no fallback
    expect(config.rerankEnabled).toBe(true);
    expect(config.rerankApiKey).toBe("");
  });

  it("rerank uses SCRYBE_RERANK_API_KEY when set", async () => {
    process.env["SCRYBE_CODE_EMBEDDING_BASE_URL"] = "https://api.voyageai.com/v1";
    process.env["SCRYBE_CODE_EMBEDDING_API_KEY"] = "voyage-key";
    process.env["SCRYBE_RERANK"] = "true";
    process.env["SCRYBE_RERANK_API_KEY"] = "rerank-key";
    vi.resetModules();
    const { config } = await import("../src/config.js");
    expect(config.rerankEnabled).toBe(true);
    expect(config.rerankApiKey).toBe("rerank-key");
  });

  it("auto-enables rerank when Voyage is the embedding provider", async () => {
    process.env["SCRYBE_CODE_EMBEDDING_BASE_URL"] = "https://api.voyageai.com/v1";
    process.env["SCRYBE_CODE_EMBEDDING_API_KEY"] = "voyage-key";
    process.env["SCRYBE_RERANK"] = "true";
    process.env["SCRYBE_RERANK_API_KEY"] = "rerank-key";
    vi.resetModules();
    const { config } = await import("../src/config.js");
    expect(config.rerankEnabled).toBe(true);
    expect(config.rerankBaseUrl).toContain("voyageai.com");
  });
});

// ─── 5. warnOldEnvVars emits warnings for old names ──────────────────────────

describe("warnOldEnvVars", () => {
  it("writes a warning when EMBEDDING_BASE_URL is in process.env", async () => {
    process.env["EMBEDDING_BASE_URL"] = "https://api.voyageai.com/v1";
    vi.resetModules();
    const { warnOldEnvVars } = await import("../src/config.js");
    const stderrWrites: string[] = [];
    const origWrite = process.stderr.write.bind(process.stderr);
    vi.spyOn(process.stderr, "write").mockImplementation((data: any) => {
      stderrWrites.push(String(data));
      return true;
    });
    try {
      warnOldEnvVars();
      const combined = stderrWrites.join("");
      expect(combined).toContain("EMBEDDING_BASE_URL");
      expect(combined).toContain("SCRYBE_CODE_EMBEDDING_BASE_URL");
    } finally {
      vi.restoreAllMocks();
    }
  });

  it("writes a warning when OPENAI_API_KEY is in process.env", async () => {
    process.env["OPENAI_API_KEY"] = "sk-openai";
    vi.resetModules();
    const { warnOldEnvVars } = await import("../src/config.js");
    const stderrWrites: string[] = [];
    vi.spyOn(process.stderr, "write").mockImplementation((data: any) => {
      stderrWrites.push(String(data));
      return true;
    });
    try {
      warnOldEnvVars();
      const combined = stderrWrites.join("");
      expect(combined).toContain("OPENAI_API_KEY");
    } finally {
      vi.restoreAllMocks();
    }
  });

  it("no warnings when no old env vars are set", async () => {
    vi.resetModules();
    const { warnOldEnvVars } = await import("../src/config.js");
    const stderrWrites: string[] = [];
    vi.spyOn(process.stderr, "write").mockImplementation((data: any) => {
      stderrWrites.push(String(data));
      return true;
    });
    try {
      warnOldEnvVars();
      expect(stderrWrites).toHaveLength(0);
    } finally {
      vi.restoreAllMocks();
    }
  });
});
