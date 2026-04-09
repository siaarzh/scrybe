# Release Process

Scrybe follows [Semantic Versioning](https://semver.org/):

- **PATCH** `x.y.Z` — bug fixes, doc corrections, internal refactors with no behavior change
- **MINOR** `x.Y.0` — new features, new env vars, new MCP tools (backwards compatible)
- **MAJOR** `X.0.0` — breaking changes (renamed/removed env vars, changed MCP tool signatures, data migration required)

---

## Steps to release

1. **Update `CHANGELOG.md`**
   - Move items from `[Unreleased]` into a new `[x.y.z] — YYYY-MM-DD` section
   - Add the new version to the comparison links at the bottom

2. **Bump `package.json`**
   ```bash
   npm version minor   # or patch / major
   # this updates "version" in package.json but does NOT create a git tag yet
   ```

3. **Build**
   ```bash
   npm run build
   ```

4. **Commit**
   ```bash
   git add CHANGELOG.md package.json package-lock.json
   git commit -m "Release vX.Y.Z"
   ```

5. **Tag**
   ```bash
   git tag vX.Y.Z
   git push && git push --tags
   ```

---

## What goes in CHANGELOG

Every user-visible change gets an entry under `[Unreleased]` as it lands:

- **Added** — new features, new env vars, new MCP tools or CLI commands
- **Changed** — changed behavior of existing features
- **Fixed** — bug fixes
- **Removed** — removed features or env vars
- **Deprecated** — features scheduled for removal

Internal refactors (renaming internal functions, reformatting code) do not need entries unless they affect the public CLI/MCP interface or `.env` config.

---

## Current version

`v0.6.3` — see [CHANGELOG.md](CHANGELOG.md).
