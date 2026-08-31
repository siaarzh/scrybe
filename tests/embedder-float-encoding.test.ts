/**
 * An OpenAI-compatible local embedding server may return float arrays even
 * when the OpenAI SDK silently asks for base64. In that case the SDK decodes
 * the float array as if it were base64 and corrupts the vector dimensions.
 *
 * Request the portable float representation explicitly so local servers such
 * as vllm-mlx return vectors the SDK preserves unchanged.
 */
import http from "node:http";
import type { AddressInfo } from "node:net";
import { afterEach, describe, expect, it } from "vitest";

const API_KEY_ENV = "SCRYBE_TEST_FLOAT_ENCODING_KEY";
const originalApiKey = process.env[API_KEY_ENV];
const servers: http.Server[] = [];

afterEach(async () => {
  await Promise.all(servers.splice(0).map((server) => new Promise<void>((resolve, reject) => {
    server.close((error) => error ? reject(error) : resolve());
  })));
  if (originalApiKey === undefined) delete process.env[API_KEY_ENV];
  else process.env[API_KEY_ENV] = originalApiKey;

  const { resetEmbedderClientCache } = await import("../src/embedder.js");
  resetEmbedderClientCache();
});

describe("OpenAI-compatible float embeddings", () => {
  it("requests float output so a local server preserves all vector dimensions", async () => {
    let encodingFormat: string | undefined;
    const server = http.createServer(async (request, response) => {
      let body = "";
      for await (const chunk of request) body += chunk;
      encodingFormat = JSON.parse(body).encoding_format;

      response.writeHead(200, { "Content-Type": "application/json" });
      response.end(JSON.stringify({
        object: "list",
        data: [{ object: "embedding", index: 0, embedding: Array(1024).fill(0) }],
        model: "local-qwen",
        usage: { prompt_tokens: 1, total_tokens: 1 },
      }));
    });
    servers.push(server);
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));

    const { port } = server.address() as AddressInfo;
    process.env[API_KEY_ENV] = "not-needed";
    const { embedQuery } = await import("../src/embedder.js");
    const vector = await embedQuery("synthetic query", {
      base_url: `http://127.0.0.1:${port}/v1`,
      model: "local-qwen",
      dimensions: 1024,
      api_key_env: API_KEY_ENV,
      provider_type: "api",
      encoding_format: "float",
    });

    expect(encodingFormat).toBe("float");
    expect(vector).toHaveLength(1024);
  });

  it("preserves the SDK's base64 default when a preset does not opt into float", async () => {
    const server = http.createServer(async (request, response) => {
      let body = "";
      for await (const chunk of request) body += chunk;
      const { encoding_format } = JSON.parse(body);
      if (encoding_format === "float") {
        response.writeHead(400, { "Content-Type": "application/json" });
        response.end(JSON.stringify({ error: { message: "float encoding is unsupported" } }));
        return;
      }

      const bytes = Buffer.alloc(1024 * Float32Array.BYTES_PER_ELEMENT);
      const encoded = bytes.toString("base64");
      response.writeHead(200, { "Content-Type": "application/json" });
      response.end(JSON.stringify({
        object: "list",
        data: [{ object: "embedding", index: 0, embedding: encoded }],
        model: "voyage-compatible",
        usage: { prompt_tokens: 1, total_tokens: 1 },
      }));
    });
    servers.push(server);
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));

    const { port } = server.address() as AddressInfo;
    process.env[API_KEY_ENV] = "not-needed";
    const { embedQuery } = await import("../src/embedder.js");
    const vector = await embedQuery("synthetic query", {
      base_url: `http://127.0.0.1:${port}/v1`,
      model: "voyage-compatible",
      dimensions: 1024,
      api_key_env: API_KEY_ENV,
      provider_type: "api",
    });

    expect(vector).toHaveLength(1024);
  });

  it("treats an explicit base64 preset as the SDK default", async () => {
    const server = http.createServer(async (_request, response) => {
      const bytes = Buffer.alloc(1024 * Float32Array.BYTES_PER_ELEMENT);
      response.writeHead(200, { "Content-Type": "application/json" });
      response.end(JSON.stringify({
        object: "list",
        data: [{ object: "embedding", index: 0, embedding: bytes.toString("base64") }],
        model: "voyage-compatible",
        usage: { prompt_tokens: 1, total_tokens: 1 },
      }));
    });
    servers.push(server);
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));

    const { port } = server.address() as AddressInfo;
    process.env[API_KEY_ENV] = "not-needed";
    const { embedQuery } = await import("../src/embedder.js");
    const vector = await embedQuery("synthetic query", {
      base_url: `http://127.0.0.1:${port}/v1`,
      model: "voyage-compatible",
      dimensions: 1024,
      api_key_env: API_KEY_ENV,
      provider_type: "api",
      encoding_format: "base64",
    });

    expect(vector).toHaveLength(1024);
  });
});
