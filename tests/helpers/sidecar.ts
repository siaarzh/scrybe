/**
 * Contract 1 — Sidecar lifecycle.
 * Exports the sidecar connection info populated by tests/setup.ts globalSetup.
 * Import this whenever a test needs to construct a project wired to the sidecar.
 */
import { readFileSync } from "fs";
import { join } from "path";
import { tmpdir } from "os";

const SIDECAR_STATE_PATH = join(tmpdir(), "scrybe-test-sidecar.json");

export const sidecar: { baseUrl: string; dimensions: number; model: string } = JSON.parse(
  readFileSync(SIDECAR_STATE_PATH, "utf8")
);
