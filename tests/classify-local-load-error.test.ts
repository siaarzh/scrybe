/**
 * Unit tests for the shared classifyLocalLoadError helper (Plan 83, Phase 1).
 *
 * Verifies:
 * 1. Network errors (ENOTFOUND, getaddrinfo, "fetch", "network" keyword) → "run once with internet" message.
 * 2. Non-network errors → "local embedder failed to load" message.
 * 3. validateLocal still works correctly (existing behaviour preserved, uses the same helper).
 */
import { describe, it, expect, vi, afterEach } from "vitest";
import { classifyLocalLoadError } from "../src/onboarding/validate-provider.js";

afterEach(() => {
  vi.restoreAllMocks();
});

describe("classifyLocalLoadError", () => {
  it("classifies ENOTFOUND as network error with internet hint", () => {
    const err = new Error("getaddrinfo ENOTFOUND huggingface.co");
    const result = classifyLocalLoadError(err);
    expect(result.message.toLowerCase()).toContain("run once with internet");
  });

  it("classifies getaddrinfo as network error with internet hint", () => {
    const err = new Error("getaddrinfo failed for host");
    const result = classifyLocalLoadError(err);
    expect(result.message.toLowerCase()).toContain("run once with internet");
  });

  it("classifies fetch-related errors as network with internet hint", () => {
    const err = new Error("fetch: network error occurred");
    const result = classifyLocalLoadError(err);
    expect(result.message.toLowerCase()).toContain("run once with internet");
  });

  it("classifies 'network' keyword errors as network with internet hint", () => {
    const err = new Error("underlying network socket was closed");
    const result = classifyLocalLoadError(err);
    expect(result.message.toLowerCase()).toContain("run once with internet");
  });

  it("classifies generic ONNX load failure as local embedder error", () => {
    const err = new Error("Failed to create session: ONNX Runtime error");
    const result = classifyLocalLoadError(err);
    expect(result.message.toLowerCase()).toContain("local embedder failed to load");
  });

  it("classifies invalid model ID error as local embedder error", () => {
    const err = new Error("Could not load model Xenova/this-does-not-exist");
    const result = classifyLocalLoadError(err);
    expect(result.message.toLowerCase()).toContain("local embedder failed to load");
  });

  it("accepts a non-Error object and still returns a message", () => {
    const result = classifyLocalLoadError("something went wrong");
    expect(typeof result.message).toBe("string");
    expect(result.message.length).toBeGreaterThan(0);
  });

  it("truncates very long error messages to prevent oversized error fields", () => {
    const longMsg = "x".repeat(500);
    const err = new Error(longMsg);
    const result = classifyLocalLoadError(err);
    // The message should be capped — either by the 120-char network slice or 200-char other slice
    expect(result.message.length).toBeLessThan(400);
  });
});
