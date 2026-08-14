/**
 * Regression tests for semantic-search fan-out.
 *
 * The vector store is mocked because it is an external database boundary; the
 * real search pipeline, source filtering, and cross-source result merging run
 * unchanged. Removing the query-embedding cache makes the first two tests
 * issue one embedding request per source instead of one per resolved config.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const state = vi.hoisted(() => ({
  project: undefined as any,
  configs: new Map<string, any>(),
}));
const initialSkipMigration = process.env.SCRYBE_SKIP_MIGRATION;

vi.mock("../src/config.js", () => ({
  config: {
    rerankEnabled: false,
    rerankFetchMultiplier: 3,
    hybridEnabled: false,
    rrfK: 60,
  },
}));

vi.mock("../src/registry.js", () => ({
  getProject: vi.fn(() => state.project),
  resolveEmbeddingConfig: vi.fn((source: { source_id: string }) => state.configs.get(source.source_id)),
}));

vi.mock("../src/plugins/index.js", () => ({
  getPlugin: vi.fn((type: string) => ({ embeddingProfile: type === "ticket" ? "text" : "code" })),
}));

vi.mock("../src/embedder.js", () => ({
  embedQuery: vi.fn(async (_query: string, config: { dimensions: number }) => [config.dimensions]),
}));

vi.mock("../src/vector-store.js", () => ({
  search: vi.fn(async (_query: number[], _projectId: string, _limit: number, tableName: string) => [
    { chunk_id: `code-${tableName}`, content: tableName },
  ]),
  ftsSearch: vi.fn(),
  searchKnowledge: vi.fn(async (_query: number[], _projectId: string, _limit: number, tableName: string) => [
    { project_id: "project", source_id: "", item_path: tableName, content: tableName, item_type: "document" },
  ]),
  ftsSearchKnowledge: vi.fn(),
}));

vi.mock("../src/reranker.js", () => ({ rerank: vi.fn() }));

vi.mock("../src/branch-state.js", () => ({
  resolveBranch: vi.fn(),
  getChunkIdsForBranch: vi.fn(),
  getBranchesForChunks: vi.fn(() => new Map()),
  resolveBranchForSearch: vi.fn(),
}));

vi.mock("../src/daemon/caller-error.js", () => ({ markCallerFacing: <T extends Error>(error: T) => error }));

function source(sourceId: string, type: "code" | "ticket") {
  return {
    source_id: sourceId,
    source_config: { type, root_path: `/fixtures/${sourceId}`, languages: [] },
    table_name: `table_${sourceId}`,
  };
}

function embeddingConfig(overrides: Record<string, unknown> = {}) {
  return {
    base_url: "http://127.0.0.1:11480/v1",
    model: "qwen3-embedding",
    dimensions: 1024,
    api_key_env: "SCRYBE_VLLM_API_KEY",
    provider_type: "api" as const,
    prompt_template: { query: "query: ", passage: "passage: " },
    max_input_tokens: 32768,
    ...overrides,
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  state.project = undefined;
  state.configs.clear();
  process.env.SCRYBE_SKIP_MIGRATION = "1";
});

afterEach(() => {
  if (initialSkipMigration === undefined) {
    delete process.env.SCRYBE_SKIP_MIGRATION;
  } else {
    process.env.SCRYBE_SKIP_MIGRATION = initialSkipMigration;
  }
});

describe("searchCode query embedding fan-out", () => {
  it("shares one embedding across code sources with an equal resolved configuration", async () => {
    state.project = { id: "code-project", sources: [source("one", "code"), source("two", "code"), source("three", "code")] };
    for (const sourceId of ["one", "two", "three"]) state.configs.set(sourceId, embeddingConfig());

    const { searchCode } = await import("../src/search.js");
    const { embedQuery } = await import("../src/embedder.js");
    const results = await searchCode("find API authentication", "code-project");

    expect(results.map((result) => result.source_id).sort()).toEqual(["one", "three", "two"]);
    expect(embedQuery).toHaveBeenCalledTimes(1);
  });

  it("keeps embeddings separate when a resolved configuration changes", async () => {
    state.project = { id: "code-project", sources: [source("one", "code"), source("two", "code"), source("three", "code")] };
    state.configs.set("one", embeddingConfig());
    state.configs.set("two", embeddingConfig({ api_key_env: "SECOND_LOCAL_PROVIDER_KEY" }));
    state.configs.set("three", embeddingConfig({ prompt_template: { query: "code query: ", passage: "code passage: " } }));

    const { searchCode } = await import("../src/search.js");
    const { embedQuery } = await import("../src/embedder.js");
    const results = await searchCode("find API authentication", "code-project");

    expect(results).toHaveLength(3);
    expect(embedQuery).toHaveBeenCalledTimes(3);
  });

  it("does not retain a query vector after the search completes", async () => {
    state.project = { id: "code-project", sources: [source("one", "code"), source("two", "code")] };
    for (const sourceId of ["one", "two"]) state.configs.set(sourceId, embeddingConfig());

    const { searchCode } = await import("../src/search.js");
    const { embedQuery } = await import("../src/embedder.js");

    await searchCode("find API authentication", "code-project");
    await searchCode("find API authentication", "code-project");

    expect(embedQuery).toHaveBeenCalledTimes(2);
  });
});

describe("searchKnowledge query embedding fan-out", () => {
  it("shares one embedding across knowledge sources with an equal resolved configuration", async () => {
    state.project = { id: "knowledge-project", sources: [source("one", "ticket"), source("two", "ticket"), source("three", "ticket")] };
    for (const sourceId of ["one", "two", "three"]) state.configs.set(sourceId, embeddingConfig());

    const { searchKnowledge } = await import("../src/search.js");
    const { embedQuery } = await import("../src/embedder.js");
    const results = await searchKnowledge("find rollout notes", "knowledge-project", 10);

    expect(results).toHaveLength(3);
    expect(embedQuery).toHaveBeenCalledTimes(1);
  });
});
