#!/usr/bin/env node
/**
 * Scrybe search toll — a Claude Code hook.
 *
 * Keyword search over an issue tracker misses the duplicate that words the
 * problem differently. Semantic search over the same issues does not. This
 * hook does not forbid the keyword path: listing issues is a legitimate thing
 * to want, and it has no wrong answer. It makes the keyword path SLOWER than
 * asking Scrybe, so it gets taken on purpose rather than out of laziness.
 *
 * It makes the wrong path slower. It does not make it impossible.
 *
 * Three modes, chosen per guard by its `action` field:
 *
 *   action: "toll"  (PreToolUse)  — deny the call, state the seconds remaining,
 *                                   allow the exact same call once the wait is
 *                                   served. State lives in one marker file.
 *
 *   action: "note"  (PostToolUse) — let the call run untouched, then attach one
 *                                   line to the result the model is already
 *                                   reading. No shared state. A note can be
 *                                   read and ignored; that is its known limit.
 *
 *   action: "auto"  (PreToolUse)  — deny only a keyword search over issues;
 *                                   allow everything else, including a bare
 *                                   list. A call is a keyword search when the
 *                                   guard is flagged `search_only: true` (the
 *                                   tool has no other purpose), or when it
 *                                   carries a non-empty free-text query (a
 *                                   qualifier-only query like `no:assignee` does
 *                                   not count — see `isBareTextQuery`). `--help`
 *                                   is never guarded. Listing — with or without
 *                                   a narrowing filter such as --milestone — is
 *                                   a different question than "find the issue
 *                                   worded like this one," and semantic search
 *                                   cannot answer it, so it is never refused.
 *                                   Denial still only fires when
 *                                   `scrybeCoverage()` says Scrybe can actually
 *                                   answer the semantic version of the question.
 *
 * The toll state machine, on a matched call:
 *
 *   marker absent          -> deny, write marker
 *   age < lower_seconds    -> deny, leave marker (still inside the wait)
 *   lower <= age < upper   -> ALLOW, leave marker (it expires on its own)
 *   age >= upper_seconds   -> deny, write marker (stale; the toll restarts)
 *
 * FAILS OPEN. Any unexpected input, missing field, unreadable config, or
 * internal error allows the call and prints nothing. A guard that can break
 * the shell is worse than the habit it fixes.
 *
 * On the allow path it prints NOTHING, deliberately. Emitting an explicit
 * "allow" would bypass the user's own permission rules for that call, which is
 * not this hook's business.
 *
 * Node, not Python: scrybe already requires node >= 22.13, and Python 3 is not
 * guaranteed on Windows. Spawns no child process.
 *
 * Configuration: see docs/search-toll.md. Defaults ship in toll.default.json
 * beside this file; <SCRYBE_DATA_DIR>/toll.json overrides them.
 */

import { appendFileSync, constants as fsConstants, readFileSync, statSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));

/** Mirrors getDataDir() in src/config.ts. Keep the two in step. */
function getDataDir() {
  if (process.env.SCRYBE_DATA_DIR) return process.env.SCRYBE_DATA_DIR;
  const home = homedir();
  if (process.platform === "win32") {
    const localAppData = process.env.LOCALAPPDATA ?? join(home, "AppData", "Local");
    return join(localAppData, "scrybe", "scrybe");
  }
  if (process.platform === "darwin") {
    return join(home, "Library", "Application Support", "scrybe");
  }
  const xdgData = process.env.XDG_DATA_HOME ?? join(home, ".local", "share");
  return join(xdgData, "scrybe");
}

function readJson(path) {
  try {
    return JSON.parse(readFileSync(path, "utf8"));
  } catch {
    return null;
  }
}

/**
 * Shipped defaults, then the user's file on top. Top-level keys override.
 * `guards` REPLACES the shipped list when present; `extra_guards` appends to
 * it, so adding one pattern does not mean recopying all of them.
 */
function loadConfig() {
  const defaults = readJson(join(HERE, "toll.default.json")) ?? {};
  // SCRYBE_TOLL_CONFIG points at a different guard config WITHOUT moving
  // SCRYBE_DATA_DIR, so the live index that search_knowledge needs stays put.
  // Lets a config be tried, or several compared, without touching a working one.
  const configPath = process.env.SCRYBE_TOLL_CONFIG || join(getDataDir(), "toll.json");
  const user = readJson(configPath) ?? {};
  const merged = { ...defaults, ...user };
  const base = Array.isArray(user.guards) ? user.guards : (defaults.guards ?? []);
  const extra = Array.isArray(user.extra_guards) ? user.extra_guards : [];
  merged.guards = [...base, ...extra];
  return merged;
}

/**
 * Character ranges of the command that sit inside single or double quotes.
 *
 * A guarded phrase appearing inside a quoted argument is being talked ABOUT,
 * not run: `grep -rn "gh issue list" .claude/` searches for the phrase, and
 * tolling it is a false positive. At a short wait that is a nuisance; at a long
 * one it locks out unrelated work, including reading the config that would
 * change the wait. Backslash escapes count inside double quotes only, matching
 * POSIX shell.
 */
function quotedSpans(command) {
  const spans = [];
  let i = 0;
  while (i < command.length) {
    const ch = command[i];
    if (ch === "\\") {
      i += 2;
      continue;
    }
    if (ch === "'" || ch === '"') {
      const start = i;
      i += 1;
      while (i < command.length) {
        if (ch === '"' && command[i] === "\\") {
          i += 2;
          continue;
        }
        if (command[i] === ch) break;
        i += 1;
      }
      spans.push([start, i]);
      i += 1;
      continue;
    }
    i += 1;
  }
  return spans;
}

/** True when the pattern matches somewhere OUTSIDE every quoted argument. */
function matchesUnquoted(pattern, command) {
  let re;
  try {
    re = new RegExp(pattern, "g");
  } catch {
    return false; // A user's broken regex disables that guard, not the hook.
  }
  const spans = quotedSpans(command);
  let m;
  while ((m = re.exec(command)) !== null) {
    if (m.index === re.lastIndex) re.lastIndex += 1; // zero-length match
    if (!spans.some(([from, to]) => m.index > from && m.index < to)) return true;
  }
  return false;
}

/** The first guard this call matches, or null. */
function matchGuard(config, toolName, command) {
  for (const guard of config.guards) {
    if (!guard || typeof guard !== "object") continue;
    if (Array.isArray(guard.tools) && guard.tools.includes(toolName)) return guard;
    if (typeof guard.pattern === "string" && typeof command === "string" && command) {
      if (matchesUnquoted(guard.pattern, command)) return guard;
    }
  }
  return null;
}

/**
 * Can Scrybe actually answer an issue question about this directory?
 *
 * Three ways the answer is no, all decidable from projects.json with no model
 * call: no project covers this path, the project has no ticket source, or that
 * source was last indexed too long ago to be trusted. Refusing the keyword path
 * in any of those cases strands the agent with no route at all, which is worse
 * than letting it run the keyword search.
 *
 * Returns { servable, reason, project }.
 */
function scrybeCoverage(config, cwd) {
  const projects = readJson(join(getDataDir(), "projects.json"));
  if (!Array.isArray(projects)) return { servable: false, reason: "no-index" };

  // Longest matching root_path wins, so a nested repo beats its parent.
  let best = null;
  for (const project of projects) {
    for (const source of project.sources ?? []) {
      const root = source.source_config?.root_path;
      if (typeof root !== "string" || !root) continue;
      if (cwd !== root && !cwd.startsWith(root.endsWith("/") ? root : `${root}/`)) continue;
      if (!best || root.length > best.rootLength) best = { project, rootLength: root.length };
    }
  }
  if (!best) return { servable: false, reason: "no-project" };

  const ticket = (best.project.sources ?? []).find((s) => s.source_config?.type === "ticket");
  if (!ticket) return { servable: false, reason: "no-ticket-source", project: best.project.id };

  const maxAge = Number(config.max_index_age_seconds);
  if (Number.isFinite(maxAge) && maxAge > 0) {
    const indexedAt = Date.parse(ticket.last_indexed ?? "");
    if (!Number.isFinite(indexedAt)) {
      return { servable: false, reason: "never-indexed", project: best.project.id };
    }
    if ((Date.now() - indexedAt) / 1000 > maxAge) {
      return { servable: false, reason: "stale-index", project: best.project.id };
    }
  }
  return { servable: true, project: best.project.id };
}

/** Free text asked as a structured MCP parameter. */
const SEARCH_PARAMS = ["search", "searchTerm", "search_term", "query"];

/**
 * A minimal quote-aware word splitter for shell command strings. Good enough to
 * pull flag values and positional arguments back out; not a full POSIX shell
 * parser (nested substitutions, `$()`, heredocs are out of scope — the guarded
 * commands never use them).
 */
function tokenize(command) {
  const tokens = [];
  let i = 0;
  while (i < command.length) {
    while (i < command.length && /\s/.test(command[i])) i += 1;
    if (i >= command.length) break;
    let token = "";
    while (i < command.length && !/\s/.test(command[i])) {
      const ch = command[i];
      if (ch === '"' || ch === "'") {
        const quote = ch;
        i += 1;
        while (i < command.length && command[i] !== quote) {
          if (quote === '"' && command[i] === "\\") {
            token += command[i + 1];
            i += 2;
            continue;
          }
          token += command[i];
          i += 1;
        }
        i += 1; // skip closing quote
      } else if (ch === "\\") {
        token += command[i + 1];
        i += 2;
      } else {
        token += ch;
        i += 1;
      }
    }
    tokens.push(token);
  }
  return tokens;
}

/** True when the command carries `--help` or a standalone `-h`. Never guarded. */
function hasHelpFlag(command) {
  if (typeof command !== "string" || !command) return false;
  const tokens = tokenize(command);
  return tokens.includes("--help") || tokens.includes("-h");
}

/**
 * Value-taking flags recognised by `gh search issues` — the ONLY flags that
 * consume the next token as an argument. Every other flag, known or unknown,
 * consumes nothing.
 *
 * This is deliberately an allowlist of what DOES eat a token, not a list of
 * what doesn't. The previous shape (a boolean/no-value set) had the polarity
 * backwards: any flag absent from that set — a short form like `-w`, or a
 * future/unrecognised long flag like `--xyz` — silently ate the next token,
 * so `gh search issues -w crash` swallowed the query and was wrongly
 * allowed. Every flag gh ever adds, and every short alias, would have been a
 * new hole. On a command whose only purpose is searching, an unrecognised
 * flag must never be able to swallow a query term — erring toward refusal
 * (treating an unknown flag's value as a leftover positional term, and thus
 * denying) is the safe failure mode here, not the alternative.
 */
const GH_SEARCH_ISSUES_VALUE_FLAGS = new Set([
  "--app",
  "--assignee",
  "--author",
  "--closed",
  "--commenter",
  "--comments",
  "--created",
  "--involves",
  "--interactions",
  "--json",
  "--jq",
  "-q",
  "--label",
  "--language",
  "--limit",
  "-L",
  "--match",
  "--mentions",
  "--merged",
  "--milestone",
  "--order",
  "--owner",
  "--project",
  "--reactions",
  "--repo",
  "-R",
  "--sort",
  "--state",
  "--team-mentions",
  "--template",
  "-t",
  "--updated",
  "--visibility",
]);

/**
 * The free-text query carried by a shell command, or "" if none.
 *
 * Two shapes: `-S <q>` / `-S<q>` / `--search <q>` / `--search=<q>` (the gh
 * CLI's own flag, both the spaced and attached short-flag forms), and the
 * positional terms of `gh search issues <terms...>` scanned across the WHOLE
 * remainder of the command, skipping flags and their values rather than
 * stopping at the first one.
 */
function extractFreeTextShell(command) {
  if (typeof command !== "string" || !command) return "";
  const tokens = tokenize(command);

  for (let i = 0; i < tokens.length; i += 1) {
    const t = tokens[i];
    if (t === "-S" || t === "--search") {
      return i + 1 < tokens.length ? tokens[i + 1] : "";
    }
    if (t.startsWith("--search=")) return t.slice("--search=".length);
    if (t.startsWith("-S") && t.length > 2) return t.slice(2);
  }

  for (let i = 0; i + 2 < tokens.length; i += 1) {
    if (tokens[i] === "gh" && tokens[i + 1] === "search" && tokens[i + 2] === "issues") {
      const terms = [];
      let endOfOptions = false;
      for (let j = i + 3; j < tokens.length; j += 1) {
        const t = tokens[j];
        if (!endOfOptions && t === "--") {
          endOfOptions = true;
          continue;
        }
        if (!endOfOptions && t.startsWith("-")) {
          if (t.includes("=")) continue; // self-contained, e.g. --limit=5
          if (t.length > 2 && !t.startsWith("--")) continue; // attached short value, e.g. -Rcli/cli, -L5
          const next = j + 1 < tokens.length ? tokens[j + 1] : undefined;
          if (GH_SEARCH_ISSUES_VALUE_FLAGS.has(t) && next !== undefined && !next.startsWith("-")) {
            j += 1; // consume the value
          }
          continue;
        }
        terms.push(t);
      }
      return terms.join(" ");
    }
  }
  return "";
}

/**
 * Coerces one MCP parameter value to the free text it carries.
 *
 * A string is used as-is. An array contributes its string/number elements
 * joined by a space (other element types are skipped, not stringified — an
 * object or null inside the array is not text). A number contributes its
 * decimal string. `null`, `undefined`, booleans, and plain objects carry no
 * free text.
 */
function coerceFreeText(value) {
  if (typeof value === "string") return value;
  if (typeof value === "number" && Number.isFinite(value)) return String(value);
  if (Array.isArray(value)) {
    return value
      .filter((el) => typeof el === "string" || (typeof el === "number" && Number.isFinite(el)))
      .map((el) => String(el))
      .join(" ");
  }
  return "";
}

/** The free-text query carried by a structured MCP call, or "" if none. */
function extractFreeTextParams(toolInput) {
  if (!toolInput || typeof toolInput !== "object") return "";
  for (const key of SEARCH_PARAMS) {
    const text = coerceFreeText(toolInput[key]);
    if (text.trim()) return text;
  }
  return "";
}

/**
 * A query counts as free text only if at least one whitespace-separated token
 * has no `:`. `gh issue list -S "no:assignee sort:created-asc"` is gh's own
 * documented example of a qualifier-only query — it contains no keywords,
 * semantic search cannot help with it, and refusing it is a false refusal.
 * `"crash on save"` has bare tokens (free text). `"crash no:assignee"` has one
 * bare token (free text). `"no:assignee sort:created-asc"` has none (not free
 * text).
 */
function isBareTextQuery(query) {
  const trimmed = String(query ?? "").trim();
  if (!trimmed) return false;
  return trimmed.split(/\s+/).some((token) => !token.includes(":"));
}

/** Filesystem-safe fragment of a session id. */
function safeKey(value) {
  const cleaned = String(value ?? "").replace(/[^A-Za-z0-9._-]/g, "");
  return cleaned.slice(0, 64) || "unknown";
}

function markerPath(config, sessionId) {
  const dir = typeof config.marker_dir === "string" && config.marker_dir ? config.marker_dir : tmpdir();
  const scope = config.scope === "session" ? `session-${safeKey(sessionId)}` : "global";
  return join(dir, `scrybe-toll-${scope}`);
}

function noteMarkerPath(config, sessionId, guardId) {
  const dir = typeof config.marker_dir === "string" && config.marker_dir ? config.marker_dir : tmpdir();
  return join(dir, `scrybe-toll-note-${safeKey(sessionId)}-${safeKey(guardId)}`);
}

/** Seconds since the marker was last written, or null when it does not exist. */
function markerAge(path) {
  try {
    return (Date.now() - statSync(path).mtimeMs) / 1000;
  } catch {
    return null;
  }
}

/**
 * O_NOFOLLOW refuses to write through a symlink planted at this predictable
 * path ahead of time (the tmp dir is shared across users on POSIX systems).
 * Undefined on Windows, where it folds to 0 in the bitwise OR and the flag
 * has no effect — the write behaves exactly as before there.
 */
const TOUCH_FLAGS =
  fsConstants.O_CREAT | fsConstants.O_WRONLY | fsConstants.O_TRUNC | (fsConstants.O_NOFOLLOW ?? 0);

function touch(path) {
  try {
    writeFileSync(path, String(Date.now()), { flag: TOUCH_FLAGS });
    return true;
  } catch {
    return false;
  }
}

function exists(path) {
  try {
    statSync(path);
    return true;
  } catch {
    return false;
  }
}

/**
 * Above this wait, the toll is a closed door in practice rather than a speed
 * bump, and the message says so instead of leading with the way around it.
 */
const CLOSED_ABOVE_SECONDS = 120;

function humanDuration(seconds) {
  if (seconds < 90) return `${seconds} seconds`;
  const minutes = Math.round(seconds / 60);
  if (minutes < 90) return `about ${minutes} minutes`;
  return `about ${Math.round(minutes / 60)} hours`;
}

/**
 * A ban. No marker, no window, no state that can run out — the command is
 * refused now and refused on the next attempt, so there is nothing to wait for
 * and nothing to spend.
 *
 * This replaced a timed toll for the shipped guards. The toll did not work: a
 * wait is a price, and an agent that can pay a price will pay it and carry on.
 * Observed in a real session — the agent waited out a 15-second toll and then
 * completed the whole task on keyword search without calling Scrybe once. It
 * was not disobedience; the message said the path was legitimate and handed
 * over the re-run recipe, so waiting was the reading the text invited. Raising
 * the price only raises what the agent is willing to wait.
 */
function banReason(guard, project, surface = "shell") {
  const hint = guard.hint ?? "search_knowledge searches the same material semantically";
  const id = project ?? "<project>";
  const lines = [
    project
      ? `NOT ALLOWED. This repo's issues are indexed in Scrybe as "${project}". Keyword search over them is closed.`
      : "NOT ALLOWED. Listing or searching issues by keyword is closed on this machine.",
    "This is not a wait. Repeating the command will not run it, now or later.",
    "",
    `Use Scrybe — ${hint}.`,
    "",
    // Rendered as a bare indented line, this read as a shell snippet and Haiku
    // pasted it into Bash, then fell back to a `scrybe search knowledge` CLI
    // guess. Measured, not theorised. Say plainly that it is a tool call.
    "Make a TOOL CALL (this is not a shell command — do not run it in Bash):",
    `  tool: mcp__scrybe__search_knowledge`,
    `  project_id: ${id}`,
    "  query: the problem in your own words",
    "",
    "Keyword listing cannot surface the ticket that describes the same thing in different",
    'words, and an empty keyword result looks exactly like "nothing exists". That miss is',
    "silent, and it is what this prevents.",
  ];

  // Under `auto`, listing is always allowed — with or without a narrowing
  // filter such as --milestone. Only a keyword search is refused, so the
  // escape is to drop the free-text keywords, not to add a filter.
  if (guard.action === "auto") {
    lines.push(
      "",
      "Listing is not blocked, with or without a filter (--milestone, --assignee, --label,",
      "--state, or the equivalent parameter). A qualifier-only search (e.g. -S \"no:assignee",
      'sort:created-asc") is not blocked either — only free-text keywords are.',
      surface === "params"
        ? "Drop the search/query parameter, or use search_knowledge above instead."
        : "Drop the keyword text, or use search_knowledge above instead."
    );
  } else {
    lines.push(
      "",
      "Do not spend the turn hunting for another command that returns the same list. If you",
      "are certain the raw list is what you need, say so to the user and let them decide."
    );
  }
  return lines.join("\n");
}

/**
 * The wording of a timed toll is load-bearing, and an earlier version worked
 * against itself: it opened by calling the keyword path legitimate and closed
 * with the exact re-run recipe, which reads as permission. Both shapes below
 * state the reason first and the escape last. `toll` is no longer the default
 * for anything shipped; it remains for users who want a speed bump rather than
 * a ban.
 */
function denyReason(guard, waitSeconds, lower, upper) {
  const hint = guard.hint ?? "search_knowledge searches the same material semantically";
  const call =
    '  mcp__scrybe__search_knowledge(project_id="<project>", query="<the problem in your own words>")';
  const why = [
    `Use Scrybe instead — ${hint}.`,
    "",
    call,
    "",
    "Keyword listing cannot surface the ticket that describes the same thing in different",
    'words, and an empty keyword result looks exactly like "nothing exists". That is the',
    "miss this exists to prevent, and it is silent when it happens.",
  ];

  if (lower > CLOSED_ABOVE_SECONDS) {
    return [
      `This path is closed on this machine for ${humanDuration(waitSeconds)}.`,
      "",
      ...why,
      "",
      "Waiting this out is not the intended move: the wait was set deliberately long, which",
      "means somebody decided this command is not how they want the question answered.",
      "Answer it with Scrybe, or tell the user the search you want to run and why.",
    ].join("\n");
  }

  return [
    "This is the keyword-only path, and it is deliberately the slow one here.",
    "",
    ...why,
    "",
    `The command is not banned: repeating it EXACTLY in ${waitSeconds} seconds will run it.`,
    "But reach for that because you decided the list is what you need, not because waiting",
    `is easier than switching. The window is ${lower}s to ${upper}s after the first attempt,`,
    "measured from the filesystem, so repeating it sooner only spends the wait again.",
  ].join("\n");
}

function noteText(guard) {
  const hint = guard.hint ?? "search_knowledge searches the same material semantically";
  return [
    "Scrybe note: that was a keyword search.",
    `${hint.charAt(0).toUpperCase()}${hint.slice(1)}.`,
    'If the result above did not answer the question, try mcp__scrybe__search_knowledge(project_id="<project>", query="<the problem in your own words>") before concluding nothing exists.',
  ].join(" ");
}

function emit(payload) {
  process.stdout.write(JSON.stringify(payload));
}

/**
 * Deny if and only if the call is a keyword search over issues AND Scrybe can
 * actually answer the semantic version of the question. Everything else runs —
 * a bare list, a list narrowed by a filter, a qualifier-only query, `--help`.
 *
 * "Keyword search" is decided two ways: a guard flagged `search_only: true`
 * (the tool has no purpose but keyword search, so any match is one — e.g.
 * `mcp__gitlab-gql__search_notes`) or a non-empty free-text query, per
 * `isBareTextQuery`. A qualifier-only query (`no:assignee sort:created-asc`)
 * is not free text: semantic search cannot help with it either, so refusing it
 * would strand the caller with no route at all.
 */
function handleAuto(config, guard, command, cwd, toolInput) {
  // A shell call is read from its command text; a tool call from its
  // structured parameters. Both surfaces get the same keyword-search test.
  const surface = typeof command === "string" && command ? "shell" : "params";

  if (surface === "shell" && hasHelpFlag(command)) return "allow-help";

  const freeText = surface === "shell" ? extractFreeTextShell(command) : extractFreeTextParams(toolInput);
  const isKeywordSearch = guard.search_only === true || isBareTextQuery(freeText);
  if (!isKeywordSearch) return "allow-not-keyword-search";

  const coverage = scrybeCoverage(config, cwd);
  if (!coverage.servable) return `allow-${coverage.reason}`;

  emit({
    hookSpecificOutput: {
      hookEventName: "PreToolUse",
      permissionDecision: "deny",
      permissionDecisionReason: banReason(guard, coverage.project, surface),
    },
  });
  return "deny";
}

function handlePreToolUse(config, guard, sessionId, command, cwd, toolInput) {
  if (guard.action === "note") return "note-deferred"; // Notes fire after the call.

  if (guard.action === "auto") return handleAuto(config, guard, command, cwd, toolInput);

  // The default. Stateless on purpose: nothing accumulates, so nothing expires.
  if (guard.action !== "toll") {
    emit({
      hookSpecificOutput: {
        hookEventName: "PreToolUse",
        permissionDecision: "deny",
        permissionDecisionReason: banReason(guard),
      },
    });
    return "deny";
  }

  const lower = Number(config.lower_seconds);
  const upper = Number(config.upper_seconds);
  if (!Number.isFinite(lower) || !Number.isFinite(upper) || lower < 0 || upper <= lower) return "allow-misconfigured";

  const path = markerPath(config, sessionId);
  const age = markerAge(path);

  if (age !== null && age >= lower && age < upper) {
    // Inside the window. Allow, print nothing. A sliding window pushes the
    // expiry out to `upper` seconds from THIS call rather than the first one.
    if (config.window === "sliding") touch(path);
    return "allow-in-window";
  }

  let wait;
  if (age === null || age >= upper) {
    // No marker, or a stale one: the toll starts (or restarts) now. If the
    // marker cannot be written, the wait would never end — allow instead.
    if (!touch(path)) return "allow-marker-unwritable";
    wait = Math.round(lower);
  } else {
    wait = Math.max(1, Math.ceil(lower - age));
  }

  emit({
    hookSpecificOutput: {
      hookEventName: "PreToolUse",
      permissionDecision: "deny",
      permissionDecisionReason: denyReason(guard, wait, Math.round(lower), Math.round(upper)),
    },
  });
  return "deny-toll";
}

function handlePostToolUse(config, guard, sessionId) {
  if (guard.action !== "note") return; // Tolled calls have had their say already.

  if (config.note_once_per_session !== false) {
    // Suppression is keyed on the SESSION, never globally: a note that fires on
    // all forty calls is one the model stops reading by call five, and a global
    // key would silence agents that never saw it.
    const path = noteMarkerPath(config, sessionId, guard.id ?? guard.pattern ?? "guard");
    if (exists(path)) return;
    touch(path);
  }

  emit({
    hookSpecificOutput: {
      hookEventName: "PostToolUse",
      additionalContext: noteText(guard),
    },
  });
}

/**
 * Append one line per observed call when SCRYBE_TOLL_LOG is set.
 *
 * The hook already sees every Bash, Grep, Glob and MCP call, which is exactly
 * the trajectory an experiment needs: which tool the agent reached for, whether
 * it was refused, and whether it came back and tried again. Recording it here
 * makes a run scoreable from a structured file instead of from its transcript.
 * Off unless the variable is set, and it never affects the decision.
 */
function logCall(event, toolName, command, decision) {
  const path = process.env.SCRYBE_TOLL_LOG;
  if (!path) return;
  try {
    appendFileSync(
      path,
      `${JSON.stringify({ event, tool: toolName, command: command ?? null, decision })}\n`
    );
  } catch {
    // Never let observability break the call it is observing.
  }
}

function readStdin() {
  try {
    return readFileSync(0, "utf8");
  } catch {
    return "";
  }
}

function main() {
  const payload = JSON.parse(readStdin());
  const event = process.argv[2] || payload.hook_event_name;
  if (event !== "PreToolUse" && event !== "PostToolUse") return;

  const config = loadConfig();
  if (config.enabled === false || !Array.isArray(config.guards) || config.guards.length === 0) return;

  const toolName = payload.tool_name;
  const command = payload.tool_input?.command;
  const guard = matchGuard(config, toolName, command);
  if (!guard) {
    logCall(event, toolName, command, "unguarded");
    return;
  }

  if (event === "PreToolUse") {
    const decision = handlePreToolUse(
      config, guard, payload.session_id, command, payload.cwd || process.cwd(), payload.tool_input
    );
    logCall(event, toolName, command, decision ?? "allow");
  } else {
    handlePostToolUse(config, guard, payload.session_id);
    logCall(event, toolName, command, "post");
  }
}

try {
  main();
} catch {
  // Fail open: print nothing, exit 0, let the call through.
}
process.exit(0);
