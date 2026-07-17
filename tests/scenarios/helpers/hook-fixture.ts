/**
 * Scenario harness — dev-checkout-guard fixture helper (Plan 102).
 *
 * Builds a temp pkgRoot with a real npm-hooks script copied into it but no `.git` present,
 * so the hook's isDevCheckout() guard resolves to false (i.e. "this is a real install").
 * Used by postinstall-dev-checkout-guard.test.ts / preinstall-dev-checkout-guard.test.ts to
 * exercise the ".git absent" branch without relying on the repo's own root (which always has
 * `.git`).
 *
 * The fixture is nested *inside* the repo (not os.tmpdir()) deliberately: when `includeDist`
 * is set, the copied `dist/index.js` still has bare-specifier imports (e.g. "openai") that
 * only resolve by Node's node_modules walk-up. Nesting under the repo root means that walk-up
 * lands on the repo's real (1.7GB) `node_modules` without copying or symlinking it — a full
 * copy is prohibitively slow/large, and a symlink hits the same Windows-privilege problem the
 * plan's D4 rejected for the fixture-rebuild alternative. The fixture's own pkgRoot still has
 * no `.git` (only its repo-root parent does), which is all isDevCheckout() checks — it does
 * not walk up. Always removed by the caller's cleanup() in afterEach; not gitignored (this
 * plan's scope is npm-hooks/* and tests/* only), so a crash mid-test could in principle leave
 * a stray `.scrybe-hookfixture-*` dir at the repo root — harmless, just `rm -rf` it.
 */
import { mkdtempSync, mkdirSync, copyFileSync, cpSync, rmSync } from "fs";
import { join } from "path";

export interface HookFixture {
  pkgRoot: string;
  hookPath: string;
  cleanup(): void;
}

/**
 * Copies `<repoRoot>/npm-hooks/<hookFile>` into a fresh temp dir at
 * `<pkgRoot>/npm-hooks/<hookFile>`, with no `.git` at pkgRoot. When `includeDist` is set,
 * also copies the real built `dist/` alongside it — post-install needs a working dist entry
 * to actually spawn a daemon; pre-install never touches dist.
 */
export function makeDevCheckoutFreePkgRoot(hookFile: string, includeDist: boolean): HookFixture {
  const pkgRoot = mkdtempSync(join(process.cwd(), ".scrybe-hookfixture-"));
  const hooksDir = join(pkgRoot, "npm-hooks");
  mkdirSync(hooksDir, { recursive: true });
  const hookPath = join(hooksDir, hookFile);
  copyFileSync(join(process.cwd(), "npm-hooks", hookFile), hookPath);
  if (includeDist) {
    cpSync(join(process.cwd(), "dist"), join(pkgRoot, "dist"), { recursive: true });
  }
  return {
    pkgRoot,
    hookPath,
    cleanup() {
      try { rmSync(pkgRoot, { recursive: true, force: true }); } catch { /* ignore */ }
    },
  };
}
