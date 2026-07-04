# Troubleshooting

## Windows + antivirus (slow indexing / `git status`)

Windows real-time AV scanning (Defender, Malwarebytes, others) can significantly slow scrybe because its
I/O profile — many small `.lance` fragment writes, frequent `git status` calls over indexed repos — is
worst-case for on-access scanning.

`scrybe doctor` detects AV products and their state and emits actionable warnings with remediation steps.

### Windows Defender — add DATA_DIR to the exclusion list

Run in an **elevated** PowerShell window (right-click → "Run as administrator"):

```powershell
Add-MpPreference -ExclusionPath "$env:LOCALAPPDATA\scrybe"
```

Verify / roll back:

```powershell
(Get-MpPreference).ExclusionPath
Remove-MpPreference -ExclusionPath "$env:LOCALAPPDATA\scrybe"
```

> If you installed scrybe with a custom `SCRYBE_DATA_DIR`, substitute that path for `$env:LOCALAPPDATA\scrybe`.

### Malwarebytes — add DATA_DIR to the allow list

Malwarebytes has no command-line API for allow-list management. Add the folder manually:

1. Open **Malwarebytes** → **Settings** → **Allow List**
2. Click **Add** → **Allow a Folder**
3. Browse to your DATA_DIR (`%LOCALAPPDATA%\scrybe` by default) and confirm

Then suppress the `scrybe doctor` warning by setting this in your DATA_DIR `.env` (or as a system env var):

```
SCRYBE_DOCTOR_AV_MBAM_VERIFIED=1
```

### Indexed repo folders — trade-off

AV scanning also applies to your indexed repo directories. Excluding them can speed up `git status` and
shell-open times, but it's a **security trade-off** — excluded paths are not scanned by real-time
protection. This is your call; `scrybe doctor` only surfaces an informational tip, it doesn't prescribe.

```powershell
# Replace with your actual repo path
Add-MpPreference -ExclusionPath "C:\path\to\your\repo"
```

**Known AV limitations:**

- **Malwarebytes allow-list**: no public API to read it, so `scrybe doctor` can't verify the exclusion —
  acknowledge manually with `SCRYBE_DOCTOR_AV_MBAM_VERIFIED=1`.
- **Other AV products** (Norton, Bitdefender, Kaspersky, etc.): not detected — consult their docs.
- **Corporate EDR / managed endpoints**: exclusions may require IT admin involvement; scrybe can't automate this.

## Linux — `npm install -g` fails with `EACCES`

If your Node came from `apt`/`dnf`/`snap`, the global npm prefix is usually root-owned. Point npm at a
user-writable location:

```bash
mkdir -p ~/.npm-global
npm config set prefix ~/.npm-global
echo 'export PATH=~/.npm-global/bin:$PATH' >> ~/.bashrc
source ~/.bashrc
```

`scrybe doctor` warns if the prefix is still not writable after installation.

## MCP shows `scrybe (install incomplete)`

If Claude Code shows an `scrybe (install incomplete)` server with a `scrybe_install_incomplete` tool, the
`npx` cache didn't finish extracting (often a first-run probe timeout). Run
`npx -y scrybe-cli@latest --version` once in a terminal (no parent timeout), then reconnect — or run
`scrybe doctor --repair`.

## After `scrybe migrate`: restart your MCP server

A migration drops and recreates LanceDB tables; long-running MCP servers cache table handles in memory
and can hit `Not found: ...lance` errors on the next search until restarted. CLI search is unaffected
(each invocation is a fresh process).
