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

import { readFileSync, statSync, writeFileSync } from "node:fs";
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
  const user = readJson(join(getDataDir(), "toll.json")) ?? {};
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
function banReason(guard) {
  const hint = guard.hint ?? "search_knowledge searches the same material semantically";
  return [
    "NOT ALLOWED. Listing or searching issues by keyword is closed on this machine.",
    "This is not a wait. Repeating the command will not run it, now or later.",
    "",
    `Use Scrybe — ${hint}:`,
    "",
    '  mcp__scrybe__search_knowledge(project_id="<project>", query="<the problem in your own words>")',
    "",
    "Keyword listing cannot surface the ticket that describes the same thing in different",
    'words, and an empty keyword result looks exactly like "nothing exists". That miss is',
    "silent, and it is what this prevents.",
    "",
    "Do not spend the turn hunting for another command that returns the same list. If you",
    "are certain the raw list is what you need, say so to the user and let them decide.",
  ].join("\n");
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

function handlePreToolUse(config, guard, sessionId) {
  if (guard.action === "note") return; // Notes fire after the call, not before.

  // The default. Stateless on purpose: nothing accumulates, so nothing expires.
  if (guard.action !== "toll") {
    emit({
      hookSpecificOutput: {
        hookEventName: "PreToolUse",
        permissionDecision: "deny",
        permissionDecisionReason: banReason(guard),
      },
    });
    return;
  }

  const lower = Number(config.lower_seconds);
  const upper = Number(config.upper_seconds);
  if (!Number.isFinite(lower) || !Number.isFinite(upper) || lower < 0 || upper <= lower) return;

  const path = markerPath(config, sessionId);
  const age = markerAge(path);

  if (age !== null && age >= lower && age < upper) {
    // Inside the window. Allow, print nothing. A sliding window pushes the
    // expiry out to `upper` seconds from THIS call rather than the first one.
    if (config.window === "sliding") touch(path);
    return;
  }

  let wait;
  if (age === null || age >= upper) {
    // No marker, or a stale one: the toll starts (or restarts) now. If the
    // marker cannot be written, the wait would never end — allow instead.
    if (!touch(path)) return;
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
  if (!guard) return;

  if (event === "PreToolUse") handlePreToolUse(config, guard, payload.session_id);
  else handlePostToolUse(config, guard, payload.session_id);
}

try {
  main();
} catch {
  // Fail open: print nothing, exit 0, let the call through.
}
process.exit(0);
