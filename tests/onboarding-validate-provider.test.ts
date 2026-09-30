import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

// Mock global fetch for provider validation tests
const mockFetch = vi.fn();

beforeEach(() => {
  vi.stubGlobal("fetch", mockFetch);
  mockFetch.mockReset();
});

async function validateProvider(spec: {
  baseUrl: string;
  model: string;
  apiKey: string;
  encodingFormat?: "float";
}) {
  const { validateProvider: validate } = await import("../src/onboarding/validate-provider.js");
  return validate(spec);
}

afterEach(() => {
  vi.unstubAllGlobals();
});

const SPEC = { baseUrl: "https://api.voyageai.com/v1", model: "voyage-code-3", apiKey: "test-key" };

function makeResp(status: number, body: unknown): Response {
  return {
    ok: status >= 200 && status < 300,
    status,
    json: async () => body,
    text: async () => JSON.stringify(body),
  } as Response;
}

describe("validateProvider", () => {
  it("validates the SDK's base64 request and decodes its dimensions", async () => {
    mockFetch.mockResolvedValueOnce(makeResp(200, {
      data: [{ embedding: Buffer.alloc(1024 * Float32Array.BYTES_PER_ELEMENT).toString("base64") }],
      model: "voyage-code-3",
    }));
    const result = await validateProvider(SPEC);
    expect(result.ok).toBe(true);
    expect(result.dimensions).toBe(1024);
    expect(result.model).toBe("voyage-code-3");
    expect(JSON.parse(mockFetch.mock.calls[0][1].body)).toEqual({
      model: "voyage-code-3", input: ["ping"], encoding_format: "base64",
    });
  });

  it("infers dimensions and float encoding from a custom endpoint's actual float request", async () => {
    mockFetch.mockResolvedValueOnce(makeResp(200, {
      data: [{ embedding: [0.1, 0.2, 0.3, 0.4] }],
      model: "local-qwen",
    }));
    const result = await validateProvider({ ...SPEC, encodingFormat: "float" });
    expect(result).toMatchObject({ ok: true, dimensions: 4, encodingFormat: "float", model: "local-qwen" });
    expect(JSON.parse(mockFetch.mock.calls[0][1].body).encoding_format).toBe("float");
  });

  it("rejects a float array from an endpoint that ignores the SDK's base64 request", async () => {
    mockFetch.mockResolvedValueOnce(makeResp(200, { data: [{ embedding: [0.1, 0.2, 0.3, 0.4] }] }));
    const result = await validateProvider(SPEC);
    expect(result).toMatchObject({ ok: false, errorType: "dimensions_unknown" });
    expect(result.message).toMatch(/encoding_format.*float/i);
  });

  it.each([
    ["base64", Buffer.alloc(16).toString("base64")],
    ["string array", ["0.1", "0.2"]],
    ["non-finite array", [0.1, Infinity]],
    ["empty array", []],
  ])("rejects %s returned for an explicit float request", async (_label, embedding) => {
    mockFetch.mockResolvedValueOnce(makeResp(200, { data: [{ embedding }] }));
    const result = await validateProvider({ ...SPEC, encodingFormat: "float" });
    expect(result).toMatchObject({ ok: false, errorType: "dimensions_unknown" });
    expect(result.message).toMatch(/encoding_format.*float.*numeric|numeric.*encoding_format.*float/i);
  });

  it.each(["not-base64!", "AA==", "AACAfw==", ""])(
    "rejects malformed or non-finite base64 embedding %s",
    async (embedding) => {
      mockFetch.mockResolvedValueOnce(makeResp(200, { data: [{ embedding }] }));
      const result = await validateProvider(SPEC);
      expect(result).toMatchObject({ ok: false, errorType: "dimensions_unknown" });
    },
  );

  it("returns auth error on 401", async () => {
    mockFetch.mockResolvedValueOnce(makeResp(401, {}));
    const result = await validateProvider(SPEC);
    expect(result.ok).toBe(false);
    expect(result.errorType).toBe("auth");
    expect(result.rawStatus).toBe(401);
  });

  it("returns auth error on 403", async () => {
    mockFetch.mockResolvedValueOnce(makeResp(403, {}));
    const result = await validateProvider(SPEC);
    expect(result.ok).toBe(false);
    expect(result.errorType).toBe("auth");
  });

  it("returns rate_limit error on 429", async () => {
    mockFetch.mockResolvedValueOnce(makeResp(429, {}));
    const result = await validateProvider(SPEC);
    expect(result.ok).toBe(false);
    expect(result.errorType).toBe("rate_limit");
  });

  it("returns other error on 500", async () => {
    mockFetch.mockResolvedValueOnce(makeResp(500, "internal error"));
    const result = await validateProvider(SPEC);
    expect(result.ok).toBe(false);
    expect(result.errorType).toBe("other");
    expect(result.rawStatus).toBe(500);
  });

  it("returns dns error on ENOTFOUND", async () => {
    const err = new Error("getaddrinfo ENOTFOUND api.voyageai.com");
    mockFetch.mockRejectedValueOnce(err);
    const result = await validateProvider(SPEC);
    expect(result.ok).toBe(false);
    expect(result.errorType).toBe("dns");
  });

  it("returns network error on timeout (AbortError)", async () => {
    const err = Object.assign(new Error("aborted"), { name: "AbortError" });
    mockFetch.mockRejectedValueOnce(err);
    const result = await validateProvider(SPEC);
    expect(result.ok).toBe(false);
    expect(result.errorType).toBe("network");
  });

  it("returns dimensions_unknown when embedding array missing", async () => {
    mockFetch.mockResolvedValueOnce(makeResp(200, { data: [{}] }));
    const result = await validateProvider(SPEC);
    expect(result.ok).toBe(false);
    expect(result.errorType).toBe("dimensions_unknown");
  });

  it("returns bad_url on invalid base URL", async () => {
    const result = await validateProvider({ ...SPEC, baseUrl: "not-a-url" });
    expect(result.ok).toBe(false);
    expect(result.errorType).toBe("bad_url");
    expect(mockFetch).not.toHaveBeenCalled();
  });
});
