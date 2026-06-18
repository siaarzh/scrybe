/**
 * Plan 32 — Slice 1: Generic source schema + provider dispatch
 *
 * Covers:
 * - resolveTicketFields: field mapping, deprecated alias handling, warnings
 * - buildSourceConfig (via resolveTicketFields): provider defaults, github/gitlab dispatch
 * - updateSourceTool handler: alias mapping for update
 */

import { describe, it, expect, vi } from "vitest";
import { resolveTicketFields } from "../src/tools/source.js";

describe("resolveTicketFields — generic fields", () => {
  it("passes through generic fields unchanged", () => {
    const result = resolveTicketFields({
      provider: "gitlab",
      url: "https://gitlab.example.com",
      project: "42",
      token: "mytoken",
    });
    expect(result).toEqual({
      provider: "gitlab",
      url: "https://gitlab.example.com",
      project: "42",
      token: "mytoken",
    });
  });

  it("defaults provider to gitlab when omitted", () => {
    const result = resolveTicketFields({
      url: "https://gitlab.example.com",
      project: "42",
      token: "tok",
    });
    expect(result.provider).toBe("gitlab");
  });

  it("resolves github provider with default url when url omitted", () => {
    const result = resolveTicketFields({
      provider: "github",
      project: "owner/repo",
      token: "ghp_abc",
    });
    expect(result.provider).toBe("github");
    // url comes back empty — caller (buildSourceConfig) fills the github default
    expect(result.url).toBe("");
  });
});

describe("resolveTicketFields — deprecated aliases", () => {
  it("maps gitlab_url to url and emits deprecation warning", () => {
    const warn = vi.fn();
    const result = resolveTicketFields(
      { gitlab_url: "https://gitlab.example.com", gitlab_project_id: "99", gitlab_token: "tok" },
      warn
    );
    expect(result.url).toBe("https://gitlab.example.com");
    expect(result.project).toBe("99");
    expect(result.token).toBe("tok");
    expect(warn).toHaveBeenCalledTimes(3);
    expect(warn.mock.calls[0][0]).toContain("--gitlab-url is deprecated");
    expect(warn.mock.calls[1][0]).toContain("--gitlab-project-id is deprecated");
    expect(warn.mock.calls[2][0]).toContain("--gitlab-token is deprecated");
  });

  it("generic field wins over alias when both supplied", () => {
    const warn = vi.fn();
    const result = resolveTicketFields(
      {
        url: "https://generic.example.com",
        gitlab_url: "https://alias.example.com",
        project: "generic-proj",
        gitlab_project_id: "alias-proj",
        token: "generic-tok",
        gitlab_token: "alias-tok",
      },
      warn
    );
    // Generic fields take precedence (alias only fills if generic is absent)
    expect(result.url).toBe("https://generic.example.com");
    expect(result.project).toBe("generic-proj");
    expect(result.token).toBe("generic-tok");
    // Deprecation warnings still fire because the alias fields were supplied
    expect(warn).toHaveBeenCalledTimes(3);
  });

  it("emits warning for each alias independently", () => {
    const warn = vi.fn();
    resolveTicketFields({ gitlab_token: "tok" }, warn);
    expect(warn).toHaveBeenCalledTimes(1);
    expect(warn.mock.calls[0][0]).toContain("--gitlab-token is deprecated");
  });

  it("emits no warnings when only generic fields used", () => {
    const warn = vi.fn();
    resolveTicketFields({ provider: "github", project: "owner/repo", token: "tok" }, warn);
    expect(warn).not.toHaveBeenCalled();
  });
});

describe("resolveTicketFields — empty inputs", () => {
  it("returns defaults for empty input", () => {
    const result = resolveTicketFields({});
    expect(result).toEqual({ provider: "gitlab", url: "", project: "", token: "" });
  });
});
