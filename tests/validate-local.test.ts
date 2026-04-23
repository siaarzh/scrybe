/**
 * Unit tests for validateLocal() in src/onboarding/validate-provider.ts.
 * Uses the already-cached all-MiniLM-L6-v2 for the success case.
 */
import { describe, it, expect } from "vitest";
import { validateLocal } from "../src/onboarding/validate-provider.js";

describe("validateLocal", () => {
  it("succeeds for a cached model — returns ok, correct dims, coldStartMs", async () => {
    const result = await validateLocal("Xenova/all-MiniLM-L6-v2");
    expect(result.ok).toBe(true);
    expect(result.dimensions).toBe(384);
    expect(result.model).toBe("Xenova/all-MiniLM-L6-v2");
    expect(typeof result.coldStartMs).toBe("number");
    expect(result.coldStartMs!).toBeGreaterThan(0);
  });

  it("fails gracefully for an invalid model ID", async () => {
    const result = await validateLocal("Xenova/this-model-does-not-exist-xyz-abc-123");
    expect(result.ok).toBe(false);
    expect(result.errorType).toBe("other");
    expect(typeof result.message).toBe("string");
    expect(result.message!.length).toBeGreaterThan(0);
  });
});
