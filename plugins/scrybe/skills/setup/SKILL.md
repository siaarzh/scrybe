---
name: setup
description: >
  LLM-guided scrybe first-run setup over MCP. Use when scrybe is not yet configured,
  the daemon is down, or the user asks to set up / configure scrybe. Walks the assistant
  through calling status → doctor → init → polling reindex_status, narrating the one-time
  model download. Works from both the healthy full toolset and the degraded 3-tool toolset
  the shim serves when the daemon is unavailable. Trigger: "set up scrybe", "configure
  scrybe", "scrybe not configured", "run scrybe init", "scrybe first run".
---

## Context: two startup states

| State | Tools available | When |
|---|---|---|
| **Degraded** (daemon unavailable) | `status`, `doctor`, `init` | First run, daemon crashed, or scrybe not yet configured |
| **Healthy** (daemon running) | Full toolset including `status`, `doctor`, `init`, `reindex_status`, `queue_status`, plus all search/index tools | Normal operation after setup |

Call `status` first to determine which state you are in.

---

## Step 1 — Check current state

Call `status` (no arguments).

Key fields in the response:

| Field | Meaning |
|---|---|
| `daemon_running` | `true` = daemon alive; `false` = degraded path |
| `config_present` | `true` = `.env` exists with provider settings |
| `code_provider_type` | Current embedding provider (`local`, `voyage`, `openai`, `custom`) |
| `config_error` | `true` = `.env` exists but has an invalid setting |

**Decision tree:**

- `daemon_running: true` AND `config_present: true` AND `config_error: false`
  → scrybe is configured and running. No setup needed. Tell the user and stop.
- `daemon_running: false` AND `config_present: true` AND `config_error: false`
  → Config exists, daemon is down. Jump to Step 3 (call `init` to restart).
- `config_present: false` OR `config_error: true`
  → Not configured or config broken. Proceed to Step 2.

---

## Step 2 — Run health check

Call `doctor` (no arguments; or `section: "Embedding Provider"` to focus).

Each check in `checks[]` has:

| Field | Type | Meaning |
|---|---|---|
| `section` | string | Category (e.g. `"Embedding Provider"`, `"Daemon"`, `"Data"`) |
| `title` | string | Check name |
| `status` | `"ok"` \| `"warn"` \| `"fail"` \| `"skip"` | Result |
| `message` | string | Human-readable detail |
| `remedy` | string \| undefined | Actionable fix if status is `warn` or `fail` |

Surface any `fail` checks to the user with their `remedy` text. If all `fail` checks are in the `"Daemon"` section only, those will clear automatically once `init` starts the daemon — proceed to Step 3.

If there are `fail` checks outside `"Daemon"` (e.g. bad API key, missing Node version), address those with the user before calling `init`.

---

## Step 3 — Call `init`

### Input shape

```json
{
  "code_provider": "local",
  "code_model": "<optional — omit for default>",
  "code_api_key": "<required for voyage/openai/custom>",
  "code_base_url": "<required for custom>",
  "code_dim": "<optional int — required only if custom provider doesn't expose dims>",
  "text_provider": "<optional — defaults to same as code_provider>",
  "text_model": "<optional>",
  "text_api_key": "<optional — defaults to code_api_key>",
  "rerank_provider": "<optional>",
  "rerank_model": "<optional>",
  "reconfigure": false
}
```

**Provider enum values:** `local` | `voyage` | `openai` | `custom`

**Zero-config path (recommended for first-time users):**
```json
{ "code_provider": "local" }
```
This uses the bundled local embedding model. No API key or internet access required (model downloads ~130 MB on first run).

**API provider example (Voyage):**
```json
{ "code_provider": "voyage", "code_api_key": "<user's voyage key>" }
```

**Already configured:** if `status` showed `config_present: true` and the user wants to reconfigure, pass `"reconfigure": true`.

### Degraded path behaviour

When called from the 3-tool degraded toolset (daemon not running), `init` first tries to auto-start the daemon. If the daemon starts, it returns:
```json
{ "ok": true, "status": "daemon_started", "message": "..." }
```
The tool surface upgrades itself automatically once the daemon is ready — no reconnect needed. Wait a few seconds, then call `init` again with provider settings.

If the daemon cannot auto-start and config is missing, the response will be:
```json
{ "ok": false, "status": "config_missing", "message": "..." }
```
Relay the `message` to the user — it explains the CLI fallback (`scrybe init` from a terminal).

### Healthy path output

A successful `init` returns:
```json
{
  "ok": true,
  "status": "configured",
  "job_id": "<uuid>",
  "indexed_projects": 0,
  "message": "..."
}
```

If there are already registered projects, `indexed_projects` > 0 and `job_id` is set — proceed to Step 4 to track progress. If `indexed_projects: 0`, setup is complete (no projects registered yet — the user can add one with `add_project` / `add_source`).

Validation is **per provider**. For **API** providers (`voyage`/`openai`/`custom`), `init` verifies the key + dimensions synchronously — a bad key returns `"ok": false, "status": "validation_failed"` with a `validation` field containing `errorType` (`auth` | `dimensions_unknown` | `network` | `dns` | `bad_url` | `other`); surface `validation.message` to the user.

For the **local** provider, `init` returns immediately **without** downloading or verifying the model — the download + load are deferred into the reindex job. So a local model problem (no internet on first run, bad custom model id) does **not** appear as `validation_failed`; it surfaces in Step 4 as a `"failed"` job with a friendly message in `error`. Always proceed to Step 4 to poll when a `job_id` is returned.

---

## Step 4 — Poll download and index progress

If `init` returned a `job_id`, poll `reindex_status` every 3–5 seconds:

```json
{ "job_id": "<uuid from init>" }
```

The `phase` field progresses through these values:

| Phase | Meaning |
|---|---|
| `"downloading-model"` | Local model weights are being fetched (~130 MB). Report `percent` to the user. |
| `"scanning"` | Enumerating files in the registered source. |
| `"embedding"` | Generating vectors and writing to the index. |
| `"done"` | Index complete. |

Narrate progress to the user at each phase transition. Example:
- `downloading-model` at 42%: "Downloading the embedding model — 42% complete. This is a one-time download."
- `scanning`: "Model ready. Scanning your codebase..."
- `embedding`: "Embedding chunks into the index..."
- `done`: "Index complete. scrybe is ready."

If `phase` is absent or `status` is `"failed"`, surface the `error` field to the user.

---

## Step 5 — Confirm ready

After `phase: "done"`, call `status` once more to confirm:
- `daemon_running: true`
- `config_present: true`
- `config_error: false`

Then tell the user: "scrybe is set up and ready. You can now use `search_code`, `search_knowledge`, and all other scrybe tools."

If setup was completed in a degraded session (3-tool toolset), no action is needed — the tool surface upgrades itself to the full toolset automatically once the daemon is ready.

---

## Notes

- **Local provider** (`code_provider: "local"`) is the default recommendation — no API key, works offline after the one-time model download.
- **Progress is always visible**: polling `reindex_status` always returns the current `phase` and `percent` — narrate this to the user rather than saying "please wait."
- **The tool surface upgrades itself**: the 3-tool toolset is served by the shim when the daemon is unavailable. Once the daemon starts (via `init` or manually), the full tool manifest loads on its own within a bounded window — no reconnect required.
- **Re-running `init`**: safe at any time. Without `reconfigure: true`, it returns `"status": "already_configured"` if a valid config exists. With `reconfigure: true`, it overwrites and re-validates.
