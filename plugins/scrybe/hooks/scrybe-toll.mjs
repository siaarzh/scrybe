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
 * Two modes, chosen per guard by its `action` field:
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

import { appendFileSync, readFileSync, statSync, writeFileSync } from "node:fs";
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

/**
 * Enumeration or similarity?
 *
 * `search_knowledge` ranks by meaning. It cannot filter by milestone, list what
 * is assigned to someone, or count — so a census question has no semantic
 * equivalent and must not be refused. A flag that narrows a set is enumeration;
 * a free-text query, or a bare list, is similarity.
 */
const ENUMERATION_FLAGS =
  /--(milestone|assignee|author|mentions|label|state|json|app|template|web)\b|-(a|A|l|s|L)\s/;

function isEnumeration(command) {
  if (/--search\b/.test(command)) return false; // free text wins even beside a filter
  return ENUMERATION_FLAGS.test(command);
}

/**
 * The same question, asked through an MCP tool instead of a shell.
 *
 * A guarded MCP call carries no command string — its arguments are structured
 * fields. Reading only `command` meant the census test never ran for these
 * tools, so `mcp__gitlab__list_issues(milestone: "26.8")` was refused exactly
 * like a bare list, and the refusal then named shell flags the caller cannot
 * use. Both halves of that are the same omission: the flag vocabulary has a
 * parameter vocabulary, and the guard only knew the first one.
 *
 * Names are unioned across the guarded GitLab tools (REST and GraphQL spell the
 * same filter differently), so one list covers all of them.
 */
const ENUMERATION_PARAMS = new Set([
  "milestone", "milestone_title",
  "assignee_id", "assignee_username", "assigneeUsernames",
  "author_id", "author_username", "authorUsername",
  "username", // get_user_issues: "everything assigned to X" is a census
  "labels", "labelNames", "label_name",
  "iids", // naming the exact issues wanted is the narrowest census of all
  "state", "scope", "issue_type", "types",
  "iteration_id", "mentions", "confidential", "due_date",
  "created_after", "created_before", "updated_after", "updated_before",
]);

/** Free text asked as a parameter. Wins over a filter, exactly as `--search` does. */
const SEARCH_PARAMS = ["search", "searchTerm", "search_term", "query"];

/**
 * Sentinels that name the whole set rather than narrowing it. `state: "all"` is
 * the default of one guarded tool, so accepting it would make a census out of a
 * parameter the caller never chose — a one-key bypass of the guard.
 */
const WIDENING_VALUES = new Set(["all", "any"]);

function narrowsTheSet(name, value) {
  if (value === null || value === undefined) return false;
  if (typeof value === "string") {
    const trimmed = value.trim();
    if (!trimmed) return false;
    return !WIDENING_VALUES.has(trimmed.toLowerCase());
  }
  if (Array.isArray(value)) return value.some((item) => narrowsTheSet(name, item));
  if (typeof value === "boolean" || typeof value === "number") return true;
  return false;
}

/**
 * Enumeration or similarity, decided from structured parameters.
 *
 * Scoping and paging (`project_id`, `projectPath`, `fullPath`, `per_page`,
 * `first`, `after`, `sort`) are deliberately absent from ENUMERATION_PARAMS: a
 * bare list of one project is still a bare list, and must stay refused.
 */
function isEnumerationParams(toolInput) {
  if (!toolInput || typeof toolInput !== "object") return false;
  for (const key of SEARCH_PARAMS) {
    if (typeof toolInput[key] === "string" && toolInput[key].trim()) return false;
  }
  for (const [key, value] of Object.entries(toolInput)) {
    if (ENUMERATION_PARAMS.has(key) && narrowsTheSet(key, value)) return true;
  }
  return false;
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

function touch(path) {
  try {
    writeFileSync(path, String(Date.now()));
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

  // Under `auto`, census questions really are allowed, and saying so is the
  // difference between a guard and a dead end. Naming the route also makes it
  // checkable: an enumeration must be expressed as one in the command itself.
  if (guard.action === "auto") {
    // The escape must be one the CALLER can take. Naming shell flags to a tool
    // call is the same dead end as naming no route at all: the agent reads an
    // allowance it has no way to express, and the guard becomes an unconditional
    // ban for that whole surface.
    lines.push(
      "",
      "If you need a CENSUS rather than a match — everything in a milestone, everything",
      "assigned to someone, a count — semantic search cannot do that, and this guard does",
      "not block it.",
      surface === "params"
        ? "Re-run this same tool with the parameter that says so (milestone, assignee_username, labels, state, or the equivalent this tool accepts) and it will run."
        : "Re-run with the filter that says so (--milestone, --assignee, --label, --state) and it will run."
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
 * Deny only when Scrybe can actually answer the question. Everything else runs.
 *
 * Under test: whether a guard that opens for census questions, unindexed repos
 * and stale indexes still holds the line on duplicate-hunting, or whether the
 * opening is simply the way around it. Not the shipped default.
 */
function handleAuto(config, guard, command, cwd, toolInput) {
  // A shell call is read from its command text; a tool call from its parameters.
  // Both surfaces get the same census test, and each is told the route it can use.
  //
  // The axis is the ABSENCE OF A COMMAND, not a `mcp__` prefix on the tool name.
  // That is deliberate, and safe for a reason worth stating rather than
  // rediscovering: absence never allows on its own. The allow still needs a
  // POSITIVE match on a narrowing parameter, so a payload that arrives
  // malformed or truncated — command field lost, parameters lost, or both —
  // produces no match and falls through to the refusal, never to an allowance.
  // A name check would behave identically today and would miss any future
  // structured surface, so do not "harden" this into one.
  const surface = typeof command === "string" && command ? "shell" : "params";
  const enumeration = surface === "shell" ? isEnumeration(command) : isEnumerationParams(toolInput);
  if (enumeration) return "allow-enumeration";

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
