---
name: scrybe
description: >
  Semantic code and knowledge search via the scrybe MCP server. Use search_code instead
  of Grep or Glob for conceptual questions about how the codebase works — finds the right
  thing even when the exact symbol name is unknown, searches across multiple repos at once,
  and handles multilingual queries (Russian or Chinese question → English code). Use
  search_knowledge for ticket or issue context. Invoke /scrybe to check registration status
  or trigger an incremental reindex of the current repo.
---

## When to call search_code (instead of Grep or Glob)

**Use `mcp__scrybe__search_code` first when the question is conceptual:**

- "how does authentication work"
- "where is the payment processing logic"
- "what handles database connection pooling"
- "show me the error handling middleware"
- "find the part that sends emails"

Grep/Glob find literal strings you already know. `search_code` finds *meaning* — even when
the exact class or function name is unknown, even across multiple registered repos, even
when the query is in a different language than the code.

**Keep using Grep or Glob when:**
- You need an exact literal match (a specific error string, a precise config key)
- scrybe has no projects registered — verify with `mcp__scrybe__list_projects` if unsure
- The user explicitly wants a raw search ("grep for 'createUser' in all files")

## When to call search_knowledge (instead of search_code)

**Use `mcp__scrybe__search_knowledge` when the user asks about context, history, or decisions:**

- "why was X implemented this way"
- "what does the ticket for feature Y say"
- "find the discussion about the auth rewrite"
- "what bugs were reported about the payment flow"

This searches indexed GitLab issues and other knowledge sources, not code.

## Checking which projects are indexed

Before searching, check registration if you're unsure:
```
mcp__scrybe__list_projects
```
Results show registered project IDs, their sources, and when they were last indexed.
Pass `project_id` to `search_code` or `search_knowledge` to scope to one project,
or omit it to search across all.

## /scrybe — reindex the current repo

When the user invokes `/scrybe`:

1. Call `mcp__scrybe__list_projects` to find registered projects.
2. Match the current working directory to a registered project's root path.
3. **If matched:** call `mcp__scrybe__reindex_project` with `project_id` and `mode: "incremental"`.
   Report: files scanned, chunks indexed.
4. **If not matched:** reply:
   > "This repo isn't indexed yet. Run `scrybe init` in your terminal — it's offline by default,
   > no API key needed. Then restart your editor to pick up the MCP config."

## Search tips

- **Multilingual queries work.** Ask in Russian or Chinese; scrybe finds English code.
- **Be vague on purpose.** "how does auth work" beats "find JwtAuthMiddleware.ts" — semantic
  search scores better on natural language than on identifier fragments.
- **Cross-repo by default.** If multiple projects are registered, a single `search_code` call
  spans all of them unless you pass `project_id`.
- **Stale results?** Run `/scrybe` to reindex, or ask the user to run `scrybe daemon kick`
  in their terminal (the background daemon keeps indexes fresh automatically when running).
