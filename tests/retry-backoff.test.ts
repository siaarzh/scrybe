/**
 * 429 retry/backoff test.
 * Starts a fresh sidecar child process with SCRYBE_SIDECAR_INJECT_429=2,
 * runs indexing against it, and asserts that indexing succeeds despite 429s.
 * Uses SCRYBE_EMBED_RETRY_DELAY_MS=200 to keep the test fast (vs 5s default).
 */
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { spawn, type ChildProcess } from "child_process";
import { join, dirname } from "path";
import { fileURLToPath } from "url";
import { cloneFixture, type FixtureHandle } from "./helpers/fixtures.js";
import { runIndex } from "./helpers/index-wait.js";
import { sidecar as mainSidecar } from "./helpers/sidecar.js";

const __dirname = dirname(fileURLToPath(import.meta.url));

interface SidecarInfo {
  port: number;
  baseUrl: string;
}

let injectedSidecar: { info: SidecarInfo; child: ChildProcess; healthUrl: string } | null = null;
let fixture: FixtureHandle | null = null;

beforeAll(async () => {
  const sidecarPath = join(__dirname, "local-embedder.ts");

  const child = spawn(process.execPath, ["--import", "tsx/esm", sidecarPath], {
    stdio: ["ignore", "pipe", "pipe"],
    env: {
      ...process.env,
      SCRYBE_SIDECAR_INJECT_429: "2",
    },
  });

  const info = await new Promise<SidecarInfo>((resolve, reject) => {
    let buf = "";
    child.stdout!.on("data", (chunk: Buffer) => {
      buf += chunk.toString();
      const nl = buf.indexOf("\n");
      if (nl !== -1) {
        try { resolve(JSON.parse(buf.slice(0, nl).trim())); }
        catch (e) { reject(e); }
      }
    });
    child.on("exit", (code) => reject(new Error(`Sidecar exited early: ${code}`)));
    setTimeout(() => reject(new Error("Sidecar startup timeout")), 30_000);
  });

  const healthUrl = `http://127.0.0.1:${info.port}/health`;

  const deadline = Date.now() + 60_000;
  while (Date.now() < deadline) {
    try {
      const r = await fetch(healthUrl);
      if (r.ok) {
        const body = await r.json() as { ready: boolean };
        if (body.ready) break;
      }
    } catch { /* not ready */ }
    await new Promise((r) => setTimeout(r, 200));
  }

  injectedSidecar = { info, child, healthUrl };
  fixture = await cloneFixture("sample-repo");
}, 90_000); // hookTimeout override for this beforeAll

afterAll(async () => {
  injectedSidecar?.child.kill("SIGTERM");
  injectedSidecar = null;
  await fixture?.cleanup();
  fixture = null;
});

describe("retry/backoff — 429 injection", () => {
  it("succeeds after 2 injected 429s and confirms retries happened", async () => {
    expect(injectedSidecar).not.toBeNull();
    expect(fixture).not.toBeNull();

    // Use fast retry delay so test doesn't take 15+ seconds
    process.env["SCRYBE_EMBED_RETRY_DELAY_MS"] = "200";

    const { addProject, addSource } = await import("../src/registry.js");
    const projectId = "test-retry-backoff";
    addProject({ id: projectId, description: "retry test" });
    addSource(projectId, {
      source_id: "primary",
      source_config: {
        type: "code",
        root_path: fixture!.path,
        languages: ["ts"],
      },
      embedding: {
        base_url: injectedSidecar!.info.baseUrl,
        model: mainSidecar.model,
        dimensions: mainSidecar.dimensions,
        api_key_env: "SCRYBE_CODE_EMBEDDING_API_KEY",
      },
    });

    const result = await runIndex(projectId, "primary", "full");
    expect(result.status).toBe("ok");
    expect(result.chunks_indexed).toBeGreaterThan(0);

    // Confirm the sidecar logged successful requests (after the 429s)
    const healthResp = await fetch(injectedSidecar!.healthUrl);
    const health = await healthResp.json() as { total_requests: number };
    expect(health.total_requests).toBeGreaterThan(0);
  }, 60_000); // per-test timeout override
});
