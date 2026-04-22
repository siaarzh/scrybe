/**
 * Local WASM embedder sidecar — speaks the OpenAI embeddings protocol.
 * Spawn as a child process; reads port from stdout first line JSON.
 * Used by tests only; never imported by production code.
 */
import http from "http";
import { pipeline, type FeatureExtractionPipeline } from "@xenova/transformers";

const MODEL_NAME = "Xenova/all-MiniLM-L6-v2";
const DIMENSIONS = 384;

let extractor: FeatureExtractionPipeline | null = null;
let modelReady = false;

// 429 injection counter (set via SCRYBE_SIDECAR_INJECT_429=N env var)
let inject429Count = parseInt(process.env.SCRYBE_SIDECAR_INJECT_429 ?? "0", 10);
let totalRequests = 0;

async function ensureModel(): Promise<FeatureExtractionPipeline> {
  if (!extractor) {
    extractor = await pipeline("feature-extraction", MODEL_NAME, { revision: "main" });
    modelReady = true;
  }
  return extractor;
}

async function embed(inputs: string[]): Promise<number[][]> {
  const model = await ensureModel();
  const output = await model(inputs, { pooling: "mean", normalize: true });
  const results: number[][] = [];
  for (let i = 0; i < inputs.length; i++) {
    results.push(Array.from(output[i].data as Float32Array));
  }
  return results;
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url ?? "/", `http://127.0.0.1`);

  if (req.method === "GET" && url.pathname === "/health") {
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(
      JSON.stringify({
        ready: modelReady,
        model: MODEL_NAME,
        dimensions: DIMENSIONS,
        total_requests: totalRequests,
      })
    );
    return;
  }

  if (req.method === "POST" && url.pathname === "/v1/embeddings") {
    let body = "";
    for await (const chunk of req) body += chunk;

    let parsed: { model?: string; input?: string | string[]; encoding_format?: string };
    try {
      parsed = JSON.parse(body);
    } catch {
      res.writeHead(400, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: { message: "Invalid JSON body" } }));
      return;
    }

    const inputs = Array.isArray(parsed.input)
      ? parsed.input
      : typeof parsed.input === "string"
      ? [parsed.input]
      : [];

    if (inputs.length === 0) {
      res.writeHead(400, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: { message: "input array must not be empty" } }));
      return;
    }

    // 429 injection for retry/backoff test
    if (inject429Count > 0) {
      inject429Count--;
      res.writeHead(429, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: { message: "Rate limit exceeded (injected for test)" } }));
      return;
    }

    totalRequests++;

    try {
      const embeddings = await embed(inputs);
      const useBase64 = parsed.encoding_format === "base64";
      const data = embeddings.map((embedding, index) => {
        let encoded: number[] | string;
        if (useBase64) {
          // Encode float32 array as base64 (matches OpenAI API default behaviour)
          const buf = Buffer.allocUnsafe(embedding.length * 4);
          for (let j = 0; j < embedding.length; j++) {
            buf.writeFloatLE(embedding[j], j * 4);
          }
          encoded = buf.toString("base64");
        } else {
          encoded = embedding;
        }
        return { object: "embedding", index, embedding: encoded };
      });
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(
        JSON.stringify({
          object: "list",
          data,
          model: MODEL_NAME,
          usage: { prompt_tokens: 0, total_tokens: 0 },
        })
      );
    } catch (err) {
      res.writeHead(500, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: { message: String(err) } }));
    }
    return;
  }

  res.writeHead(404);
  res.end();
});

server.listen(0, "127.0.0.1", () => {
  const addr = server.address();
  if (!addr || typeof addr === "string") {
    process.stderr.write("Failed to get server address\n");
    process.exit(1);
  }
  const port = addr.port;
  const baseUrl = `http://127.0.0.1:${port}/v1`;
  // First stdout line — parsed by tests/setup.ts global setup
  process.stdout.write(JSON.stringify({ port, baseUrl }) + "\n");

  // Eager model load so /health becomes ready=true quickly
  ensureModel().catch((err) => {
    process.stderr.write(`Model load error: ${err}\n`);
    process.exit(1);
  });
});
