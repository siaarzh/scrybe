# Contributing to scrybe

## Running tests locally

```bash
npm ci
npm run build
npm test
```

Tests run offline — no API keys or network access needed. Model weights are downloaded once and cached in `~/.cache/huggingface/` (~23 MB).

## How the test setup works

### Local embedder sidecar

`tests/local-embedder.ts` is a minimal HTTP server that speaks the OpenAI embeddings protocol (`POST /v1/embeddings`). It loads `Xenova/all-MiniLM-L6-v2` (384-dim, pure-WASM ONNX) and returns real embeddings — no mocking.

Vitest's `globalSetup` (`tests/setup.ts`) spawns it as a child process, polls `/health` until the model is warm, then writes the sidecar's port to a temp file. All test files read that temp file via `tests/helpers/sidecar.ts`.

The sidecar supports `encoding_format: "base64"` (required by OpenAI SDK v4 defaults) and `SCRYBE_SIDECAR_INJECT_429=N` for retry testing.

### Per-test isolation

`tests/isolate.ts` runs as Vitest `setupFiles` (once per test file). In `beforeEach` it:
1. Creates a fresh `mkdtemp` directory and sets `SCRYBE_DATA_DIR` to it
2. Points `EMBEDDING_BASE_URL` at the shared sidecar
3. Calls `vi.resetModules()` so `src/config.ts` re-evaluates env vars for the next test

Test helpers (`tests/helpers/`) use **dynamic imports** for all `src/` modules. This ensures each test gets a fresh module instance that reads the correct `SCRYBE_DATA_DIR`.

### Why `fileParallelism: false`?

LanceDB writes to disk under `SCRYBE_DATA_DIR`. Tests run in the same process but LanceDB holds file locks. Running test files in parallel caused lock contention — disabling parallel execution is simpler than per-test sharding.

## Cross-stub contracts

M-D0 exposes 8 contracts that downstream milestones (M-D1, M-D2, M-D3) must not change:

| Contract | File | Description |
|---|---|---|
| 1 | `tests/helpers/sidecar.ts` | `{ baseUrl, dimensions, model }` — sidecar connection info |
| 2 | `tests/helpers/fixtures.ts` | `cloneFixture(name): FixtureHandle` |
| 3 | `tests/helpers/sentinel.ts` | `sentinel(label?): string` — unique BM25 tokens |
| 4 | `tests/helpers/project.ts` | `createTempProject(opts): TempProject` |
| 5 | `tests/helpers/index-wait.ts` | `runIndex(projectId, sourceId, mode): IndexResult` |
| 5b | `tests/helpers/search.ts` | `search(projectId, query): SearchResult[]` |
| 6 | `tests/isolate.ts` | Env var surface: `SCRYBE_DATA_DIR`, `EMBEDDING_BASE_URL`, etc. |
| 7 | `src/embedder.ts` | `resetEmbedderClientCache()` export |
| 8 | `tests/fixtures/sample-repo/` | Fixture shape — frozen, add new fixtures don't modify existing |

## Adding a new test

1. Import helpers from `tests/helpers/` (never import `src/` directly with static imports)
2. Use `cloneFixture("sample-repo")` + `createTempProject(...)` to get an isolated repo + project
3. Use `sentinel()` to create unique tokens for BM25-reliable assertions
4. Clean up with `afterEach` calling `fixture.cleanup()` and `project.cleanup()`

Example:
```ts
import { cloneFixture } from "./helpers/fixtures.js";
import { createTempProject } from "./helpers/project.js";
import { runIndex } from "./helpers/index-wait.js";
import { search } from "./helpers/search.js";
import { sentinel } from "./helpers/sentinel.js";

it("my test", async () => {
  const fixture = await cloneFixture("sample-repo");
  const project = await createTempProject({ rootPath: fixture.path });
  try {
    const token = sentinel("my-test");
    // ... write file with token, index, search ...
  } finally {
    await project.cleanup();
    await fixture.cleanup();
  }
});
```

## When a test fails

- **Sidecar startup timeout**: model download blocked by network. Run `npm test` once on a connected machine to cache the model, then offline runs work.
- **Dimension mismatch**: sidecar returned wrong embedding size. Check `EMBEDDING_DIMENSIONS` env var vs actual model output.
- **LanceDB lock errors**: another test is holding a table lock. `fileParallelism: false` prevents this in CI, but manually running individual test files in parallel can cause it.
- **"close timed out"**: LanceDB's native addon holds an event loop ref — this is cosmetic, tests still exit with code 0.
