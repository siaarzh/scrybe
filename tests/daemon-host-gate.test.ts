/**
 * Unit tests for the pure Host/Origin allowlist module (GitHub issue #102).
 * No HTTP server involved — these exercise parsing and matching directly.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { parseHostHeader, checkHostAndOrigin } from "../src/daemon/host-gate.js";

const ORIGINAL_ALLOWED_HOSTS = process.env["SCRYBE_DAEMON_ALLOWED_HOSTS"];

afterEach(() => {
  if (ORIGINAL_ALLOWED_HOSTS === undefined) delete process.env["SCRYBE_DAEMON_ALLOWED_HOSTS"];
  else process.env["SCRYBE_DAEMON_ALLOWED_HOSTS"] = ORIGINAL_ALLOWED_HOSTS;
});

beforeEach(() => {
  delete process.env["SCRYBE_DAEMON_ALLOWED_HOSTS"];
});

describe("parseHostHeader", () => {
  it("drops a numeric port from a plain host", () => {
    expect(parseHostHeader("127.0.0.1:58451")).toBe("127.0.0.1");
    expect(parseHostHeader("localhost:8080")).toBe("localhost");
    expect(parseHostHeader("evil.example.com:80")).toBe("evil.example.com");
  });

  it("passes through a plain host with no port", () => {
    expect(parseHostHeader("localhost")).toBe("localhost");
  });

  it("lowercases the hostname", () => {
    expect(parseHostHeader("LOCALHOST:1234")).toBe("localhost");
  });

  it("handles a bracketed IPv6 literal with a port", () => {
    expect(parseHostHeader("[::1]:58451")).toBe("::1");
  });

  it("handles a bracketed IPv6 literal with no port", () => {
    expect(parseHostHeader("[::1]")).toBe("::1");
  });

  it("does not crash on a malformed bracketed literal", () => {
    expect(parseHostHeader("[::1")).toBeNull();
  });

  it("returns null for a missing or empty Host header", () => {
    expect(parseHostHeader(undefined)).toBeNull();
    expect(parseHostHeader("")).toBeNull();
    expect(parseHostHeader("   ")).toBeNull();
  });
});

describe("checkHostAndOrigin", () => {
  it("allows localhost and 127.0.0.1 by default", () => {
    expect(checkHostAndOrigin("127.0.0.1:58451", undefined)).toEqual({ allowed: true });
    expect(checkHostAndOrigin("localhost:58451", undefined)).toEqual({ allowed: true });
  });

  it("rejects a foreign Host", () => {
    const result = checkHostAndOrigin("evil.example.com", undefined);
    expect(result.allowed).toBe(false);
    expect(result.reason).toBe("foreign-host");
  });

  it("rejects a missing Host", () => {
    const result = checkHostAndOrigin(undefined, undefined);
    expect(result.allowed).toBe(false);
    expect(result.reason).toBe("missing-host");
  });

  it("passes when Origin is absent", () => {
    expect(checkHostAndOrigin("127.0.0.1:58451", undefined)).toEqual({ allowed: true });
  });

  it("rejects any Origin, even one naming an unrelated foreign host", () => {
    const result = checkHostAndOrigin("127.0.0.1:58451", "https://evil.example.com");
    expect(result.allowed).toBe(false);
    expect(result.reason).toBe("origin-present");
  });

  it("rejects the literal Origin: null", () => {
    const result = checkHostAndOrigin("127.0.0.1:58451", "null");
    expect(result.allowed).toBe(false);
    expect(result.reason).toBe("origin-present");
  });

  it("rejects an empty-string Origin header", () => {
    const result = checkHostAndOrigin("127.0.0.1:58451", "");
    expect(result.allowed).toBe(false);
    expect(result.reason).toBe("origin-present");
  });

  it("rejects an Origin that matches the allowed host — only browsers send Origin at all", () => {
    const result = checkHostAndOrigin("127.0.0.1:58451", "http://127.0.0.1:5173");
    expect(result.allowed).toBe(false);
    expect(result.reason).toBe("origin-present");
  });

  it("adds a name via SCRYBE_DAEMON_ALLOWED_HOSTS, additively", () => {
    process.env["SCRYBE_DAEMON_ALLOWED_HOSTS"] = "proxy.internal.example";
    expect(checkHostAndOrigin("proxy.internal.example", undefined)).toEqual({ allowed: true });
    // built-ins still work alongside the addition
    expect(checkHostAndOrigin("127.0.0.1", undefined)).toEqual({ allowed: true });
    expect(checkHostAndOrigin("localhost", undefined)).toEqual({ allowed: true });
  });

  it("trims whitespace and matches case-insensitively across multiple entries", () => {
    process.env["SCRYBE_DAEMON_ALLOWED_HOSTS"] = " Proxy-A.example , PROXY-B.example  ";
    expect(checkHostAndOrigin("proxy-a.example", undefined)).toEqual({ allowed: true });
    expect(checkHostAndOrigin("proxy-b.example", undefined)).toEqual({ allowed: true });
  });

  it("cannot be used to remove the built-ins", () => {
    process.env["SCRYBE_DAEMON_ALLOWED_HOSTS"] = "only-this.example";
    // the env value omits localhost/127.0.0.1 entirely — they must still work
    expect(checkHostAndOrigin("127.0.0.1", undefined)).toEqual({ allowed: true });
    expect(checkHostAndOrigin("localhost", undefined)).toEqual({ allowed: true });
    expect(checkHostAndOrigin("only-this.example", undefined)).toEqual({ allowed: true });
  });

  it("does not allow the bracketed IPv6 loopback literal by default", () => {
    const result = checkHostAndOrigin("[::1]:58451", undefined);
    expect(result.allowed).toBe(false);
    expect(result.reason).toBe("foreign-host");
  });

  it("ignores an allowlist entry with a port and warns once, not per call", () => {
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
    try {
      process.env["SCRYBE_DAEMON_ALLOWED_HOSTS"] = "bad-entry:1234,good.example";
      const result = checkHostAndOrigin("bad-entry", undefined);
      expect(result.allowed).toBe(false);
      expect(result.reason).toBe("foreign-host");
      expect(checkHostAndOrigin("good.example", undefined)).toEqual({ allowed: true });
      checkHostAndOrigin("good.example", undefined);
      expect(warnSpy).toHaveBeenCalledTimes(1);
    } finally {
      warnSpy.mockRestore();
    }
  });
});
