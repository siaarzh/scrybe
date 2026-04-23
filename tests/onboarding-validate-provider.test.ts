import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { validateProvider } from "../src/onboarding/validate-provider.js";

// Mock global fetch for provider validation tests
const mockFetch = vi.fn();

beforeEach(() => {
  vi.stubGlobal("fetch", mockFetch);
  mockFetch.mockReset();
});

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
  it("returns ok with dimensions on 200 success", async () => {
    mockFetch.mockResolvedValueOnce(makeResp(200, {
      data: [{ embedding: new Array(1024).fill(0.1) }],
      model: "voyage-code-3",
    }));
    const result = await validateProvider(SPEC);
    expect(result.ok).toBe(true);
    expect(result.dimensions).toBe(1024);
    expect(result.model).toBe("voyage-code-3");
  });

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
