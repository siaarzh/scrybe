# Search guard

The Scrybe plugin for Claude Code ships a hook that refuses keyword-only searches over an issue tracker and points the agent at semantic search instead.

**What it does.** By default it refuses the command **only when Scrybe can actually answer the question** — the repo's issues are indexed, the index is fresh, and the question is a similarity question rather than a census. The refusal does not expire: there is no wait, no window, and no state that runs out. In every other case the command runs untouched, because refusing it would offer a replacement that cannot help.

**What it does not do.** It cannot stop an agent that goes looking for a different command that returns the same list. It guards the commands it knows about, and that list is a starting point rather than a perimeter. It also does not stop a human from running the command in a terminal, which is the point — the rule is about how agents answer questions, not about who may read an issue list.

The hook is off with one config key, and it fails open: any malformed input, unreadable config, or internal error lets the call through and prints nothing.

## Why it exists

Keyword search finds the ticket that uses your words. It misses the ticket that describes the same defect in different words. Semantic search over the same issues, including their comment threads, finds that one. The cost of the miss is a duplicate filing, and the miss is silent — an empty result reads exactly like "nothing exists".

Instructions in a `CLAUDE.md` file do not reliably fix this, because an agent reaching for `gh issue list` is not reaching for `grep`, so a rule about `grep` never fires. This hook does not depend on the agent agreeing with it.

## Why it is a ban and not a wait

Earlier versions of this made the keyword path slower rather than closed: a first attempt was denied, and repeating the command after fifteen seconds ran it. **That does not work, and the reason is worth stating plainly, because it is the whole design.**

A wait is a price. An agent that can pay a price will pay it. Re-running a command already sitting in its context costs one tool call; switching to semantic search means composing a query, choosing `top_k`, and reading a different result shape. Fifteen seconds is cheaper than that, so waiting is the rational move, not a lapse. Raising the price does not fix it either — it only raises the wait the agent is willing to sit through.

The message made it worse. It opened by calling the keyword path legitimate and closed with the exact re-run recipe, so the last thing the agent read was the workaround. Observed in a real session: the agent paid the fifteen seconds, then completed the entire task on keyword search without calling Scrybe once, and missed two neighbouring issues that semantic search returned immediately.

So the default is a refusal that does not expire. The timed toll is still available for anyone who genuinely wants a speed bump, but nothing ships using it.

## The three modes

Each guard chooses one, with its `action` field. **`auto` is what ships.** A guard that omits `action` entirely gets the unconditional `deny`, which is the stricter reading of an unstated intent.

### `auto` — refuse only where Scrybe can serve (shipped default)

Two deterministic checks, both from files already on disk, before any refusal:

**1. Is this a census or a similarity question?** A flag that narrows a set — `--milestone`, `--assignee`, `--author`, `--label`, `--state`, `--json` — means the caller wants a list. `search_knowledge` ranks by meaning and cannot filter or count, so a census has no semantic equivalent and is allowed. Free text (`--search`) or a bare list means a similarity question, and free text wins even when a filter sits beside it — otherwise adding one flag would bypass the guard.

A guarded **MCP tool** carries no command line, so the same test reads its parameters instead: `milestone`, `assignee_username`, `assigneeUsernames`, `author_username`, `labels`, `labelNames`, `iids`, `state`, `scope`, `types`, `username` and the other set-narrowing names mark a census. Scoping and paging (`project_id`, `projectPath`, `fullPath`, `per_page`, `first`, `after`, `sort`) do not — a bare list of one project is still a bare list. A value that narrows nothing (`state: "all"`, `scope: "all"`, an empty string or empty array) does not count either. `search` / `searchTerm` is free text and wins beside a filter, exactly as `--search` does.

**2. Does Scrybe cover this repo?** Read from `projects.json`: no project covering this directory, no ticket source on that project, or a `last_indexed` older than `max_index_age_seconds` all mean Scrybe has nothing to offer. Each one allows the command.

Only when both checks say Scrybe can answer does the refusal fire — and it names the project id, so the agent does not have to guess it, and it names the census route in the vocabulary the caller can use: shell flags for a shell command, parameter names for a tool call.

**Why this is the default**, measured rather than assumed: against the unconditional ban it removed 6/6 false refusals at the guard layer and 8 of 9 stranded agents at the behaviour layer, with **zero** cases of an agent using the census route to grab the list it was refused. Full write-up in the internal experiment record.

### `deny` — refused, every time

The call is denied and the agent is told to use `search_knowledge`. Nothing is recorded, so there is nothing to wait out and nothing that can expire into an allowance. A second attempt gets the identical refusal. Because it keeps no state, it also cannot be defeated by an unwritable filesystem.

The message tells the agent not to go hunting for an equivalent command, and to raise it with the user if it believes the raw list is genuinely needed.

### `toll` — pay a wait, then proceed (opt-in)

Read [Why it is a ban and not a wait](#why-it-is-a-ban-and-not-a-wait) before choosing this. It is kept for cases where the keyword path is genuinely legitimate and you only want the agent to stop and think.

The call is denied, with a message stating the number of seconds remaining. Repeating the exact command after the wait runs it.

| marker age | decision | marker rewritten |
|---|---|---|
| absent | deny | yes |
| below `lower_seconds` | deny — still inside the wait | no |
| between `lower_seconds` and `upper_seconds` | **allow** | no |
| `upper_seconds` or more | deny — stale, the wait restarts | yes |

The wait is measured from a marker file, not guessed, so retrying early is visibly pointless rather than worth a try. On the allow path the hook prints nothing at all — emitting an explicit allow would bypass your own permission rules for that call.

If you choose it, price it deliberately. See [Pricing a toll](#pricing-a-toll).

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
| `max_index_age_seconds` | `86400` | `auto` only. An issue index older than this is treated as unable to answer, so the command runs. Set high if you index rarely and trust the index anyway; set low if you file issues faster than you index. |
| `guards` | see below | Replaces the shipped guard list outright. |
| `extra_guards` | `[]` | Appends to the shipped guard list, so adding one pattern does not mean recopying all of them. |

### Guards

A guard matches either a shell command or a tool name.

```json
{
  "id": "gh-issue-list",
  "action": "deny",
  "pattern": "\\bgh\\s+issue\\s+list\\b",
  "hint": "search_knowledge over this repo's issue source finds the duplicate that words it differently"
}
```

| Field | Meaning |
|---|---|
| `id` | A short name. Used to key the once-per-session note suppression. |
| `action` | `"auto"` (shipped), `"deny"`, `"toll"`, or `"note"`. A guard that omits it gets `"deny"`. |
| `pattern` | A JavaScript regular expression, tested against the `Bash` tool's command string. |
| `tools` | A list of exact tool names, for MCP tools and built-in tools where the match is on the name rather than a shell string. |
| `hint` | One clause naming what Scrybe does better here. It is quoted back to the agent in both modes. |

A guard may set `pattern`, `tools`, or both. A guard whose regular expression does not compile is skipped; the other guards keep working.

**A guarded phrase inside a quoted argument does not count.** `grep -rn "gh issue list" .claude/` searches for the phrase rather than running it, so it is not tolled. `gh issue list --search "crash on save"` still is, because the match falls outside the quotes. Quoting is read the way a POSIX shell reads it, so an unquoted `grep -rn gh\ issue\ list` does still match.

## Pricing a toll

`lower_seconds` has to cost more than what it displaces, or paying it is the rational move and the toll changes nothing.

Re-running a command already sitting in the agent's context is one tool call. Switching to semantic search means composing a query, choosing `top_k`, and reading a different result shape. A 15-second wait is cheaper than that, so an agent will reliably wait and proceed — which is not disobedience, it is arithmetic. This was observed in a real session: the agent paid the 15-second toll, then completed the entire task on keyword search without calling Scrybe once.

Set the price for the behaviour you want:

| `lower_seconds` | What it is in practice |
|---|---|
| 15–60 | A speed bump. The agent notices, and usually pays and continues. |
| 60–120 | Real friction. Switching starts to look cheaper than waiting. |
| Above 120 | Closed in practice. The deny message stops presenting the wait as a way through and tells the agent to use Scrybe or ask the user. |

Above 120 seconds the wording changes automatically — a long wait paired with a cheerful "repeat it in N seconds and it will run" reads as permission, which defeats the setting.

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

Add your own banned command without touching the shipped list:

```json
{
  "extra_guards": [
    { "id": "rg-issues", "action": "deny", "pattern": "\\brg\\b.*\\bissues\\b", "hint": "search_code finds this by concept, not by literal string" }
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

## Choosing `scope` and `window` (toll only)

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
