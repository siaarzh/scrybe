# Search toll

The Scrybe plugin for Claude Code ships a hook that reacts when an agent reaches for a keyword-only search over an issue tracker.

**What it does and does not do.** It makes the keyword path slower than asking Scrybe. It does not make the keyword path impossible, and it is not meant to. Listing issues has no wrong answer — sometimes a list is exactly what you want, and semantic search is a different tool for a different question. The point is that the slower path gets taken on purpose rather than out of habit. An agent that decides it wants the list still gets the list.

The hook is off with one config key, and it fails open: any malformed input, unreadable config, or internal error lets the call through and prints nothing.

## Why it exists

Keyword search finds the ticket that uses your words. It misses the ticket that describes the same defect in different words. Semantic search over the same issues, including their comment threads, finds that one. The cost of the miss is a duplicate filing, and the miss is silent — an empty result reads exactly like "nothing exists".

Instructions in a `CLAUDE.md` file do not reliably fix this, because an agent reaching for `gh issue list` is not reaching for `grep`, so a rule about `grep` never fires. This hook does not depend on the agent agreeing with it.

## The two modes

Each guard chooses one, with its `action` field.

### `toll` — pay a wait, then proceed

The call is denied, with a message stating the number of seconds remaining. Repeating the exact command after the wait runs it.

| marker age | decision | marker rewritten |
|---|---|---|
| absent | deny | yes |
| below `lower_seconds` | deny — still inside the wait | no |
| between `lower_seconds` and `upper_seconds` | **allow** | no |
| `upper_seconds` or more | deny — stale, the wait restarts | yes |

The wait is measured from a marker file, not guessed, so retrying early is visibly pointless rather than worth a try. On the allow path the hook prints nothing at all — emitting an explicit allow would bypass your own permission rules for that call.

### `note` — let it run, then say something

The call runs untouched. One line is then attached to the result the agent is already reading, at the moment it decides what to do with the output.

A note can be read and ignored. Its advantage over a line in a `CLAUDE.md` file is position, not force. It arrives inside the result rather than thousands of tokens earlier. That is a real improvement and it is not a guarantee.

Notes fire once per session per guard by default, because a note that fires on all forty calls is one the agent stops reading by call five.

## Configuration

Defaults ship in `plugins/scrybe/hooks/toll.default.json` inside the plugin. **Do not edit that file** — a plugin update overwrites it.

Your settings go in `toll.json` in the Scrybe data directory, beside `projects.json`:

- Linux: `~/.local/share/scrybe/toll.json` (or `$XDG_DATA_HOME/scrybe/toll.json`)
- macOS: `~/Library/Application Support/scrybe/toll.json`
- Windows: `%LOCALAPPDATA%\scrybe\scrybe\toll.json`
- Any platform: `$SCRYBE_DATA_DIR/toll.json` when that variable is set

Top-level keys you set override the shipped ones. Keys you leave out keep their default.

| Key | Default | Meaning |
|---|---|---|
| `enabled` | `true` | Set to `false` to turn the whole hook off. |
| `lower_seconds` | `15` | How long the wait lasts before a tolled command will run. |
| `upper_seconds` | `30` | How long the paid window stays open before the toll restarts. Raise it for a long burst of calls — see below. |
| `scope` | `"global"` | `"global"`: one window shared by every agent on the machine. `"session"`: each session pays its own toll. |
| `window` | `"fixed"` | `"fixed"`: the window expires `upper_seconds` after the FIRST attempt. `"sliding"`: every allowed call pushes the expiry out. |
| `marker_dir` | system temp directory | Where the marker files live. |
| `note_once_per_session` | `true` | Set to `false` to let a `note` guard fire on every matching call. |
| `guards` | see below | Replaces the shipped guard list outright. |
| `extra_guards` | `[]` | Appends to the shipped guard list, so adding one pattern does not mean recopying all of them. |

### Guards

A guard matches either a shell command or a tool name.

```json
{
  "id": "gh-issue-list",
  "action": "toll",
  "pattern": "\\bgh\\s+issue\\s+list\\b",
  "hint": "search_knowledge over this repo's issue source finds the duplicate that words it differently"
}
```

| Field | Meaning |
|---|---|
| `id` | A short name. Used to key the once-per-session note suppression. |
| `action` | `"toll"` or `"note"`. Defaults to a toll if omitted. |
| `pattern` | A JavaScript regular expression, tested against the `Bash` tool's command string. |
| `tools` | A list of exact tool names, for MCP tools and built-in tools where the match is on the name rather than a shell string. |
| `hint` | One clause naming what Scrybe does better here. It is quoted back to the agent in both modes. |

A guard may set `pattern`, `tools`, or both. A guard whose regular expression does not compile is skipped; the other guards keep working.

### What ships guarded

Issue **listing and searching** only: `gh issue list`, `gh search issues`, `gh api .../search/issues`, `glab issue list`, and the GitLab MCP tools that trawl for issues (`list_issues`, `my_issues`, `get_issues`, `search_issues`, `get_user_issues`, `list_work_items`).

Deliberately **not** guarded: `gh issue view`, `create`, `comment`, `edit`, `close`, anything under `gh pr`, and every single-issue read such as `get_issue`. The toll is on trawling for something, never on reading or filing the one you already found — guarding those would break issue filing, which is the activity this exists to improve.

### Examples

Turn it off:

```json
{ "enabled": false }
```

Give a burst of calls five minutes of room instead of thirty seconds:

```json
{ "upper_seconds": 300 }
```

Add your own tolled command without touching the shipped list:

```json
{
  "extra_guards": [
    { "id": "rg-issues", "action": "toll", "pattern": "\\brg\\b.*\\bissues\\b", "hint": "search_code finds this by concept, not by literal string" }
  ]
}
```

Nudge instead of blocking, everywhere:

```json
{
  "guards": [
    { "id": "gh-issue-list", "action": "note", "pattern": "\\bgh\\s+issue\\s+list\\b", "hint": "search_knowledge searches issue bodies AND comments" }
  ]
}
```

## Choosing `scope` and `window`

The default is a single global marker with a fixed window, which means two things worth knowing.

**Agents share one window.** When one agent pays the toll, every other agent on the machine can act inside the same window without paying. This is deliberate: the contended action is a read, and the answer to wanting one is Scrybe either way. Set `scope: "session"` if you would rather each agent paid its own toll.

**A fixed window expires on schedule.** It ends `upper_seconds` after the first attempt regardless of how much traffic passes through it, so busy agents cannot hold it open. A sliding window pushes the expiry out on every allowed call, which serves a long burst better — but combined with the global default it means three busy agents keep the window permanently warm, and a fourth agent that should be using Scrybe inherits an allowance it never earned. Pair `window: "sliding"` with `scope: "session"` if you want the sliding behaviour without that.

## Cost and scope of the hook

The hook runs on `Bash`, `Grep`, `Glob`, and every MCP tool call, and costs roughly 30 ms on calls that match no guard. It never spawns a child process and reads two small JSON files.

It adds nothing to the model's context: hooks are harness-level, so the guard list is not something the model reads or pays for.

To guard a tool outside that set — `Read`, `Edit`, `Write`, `Task` — add your own hook entry in `settings.json` pointing at the same script with a wider matcher:

```json
{
  "hooks": {
    "PreToolUse": [
      {
        "matcher": "Read|Task",
        "hooks": [{ "type": "command", "command": "node \"$HOME/.claude/plugins/cache/scrybe/scrybe/<version>/plugins/scrybe/hooks/scrybe-toll.mjs\" PreToolUse", "timeout": 5 }]
      }
    ]
  }
}
```

## Requirements

Node 22.13 or newer, which Scrybe already requires. The hook is deliberately not written in Python: Python 3 is not guaranteed to be present, and on Windows the default `python3` alias opens the Microsoft Store rather than running anything.
