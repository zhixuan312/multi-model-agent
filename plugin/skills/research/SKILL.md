---
name: research
description: Use when you need external multi-source research with citations — arxiv, semantic_scholar, github_search, brave-with-site:-filters — for a focused question. Worker is bibliographic, not opinionated. Pair with mma:investigate (internal) under mma:explore for divergent landscape scans.
when_to_use: An external-research question has surfaced (state of the art, prior art, what others do, what published methods exist) AND mma is running. Delegate the multi-source web/adapter research to a worker so the main context stays on judgment. NOT for codebase questions — those are mma:investigate.
version: "0.0.0-unreleased"
---

# mma:research

## Overview

Run external multi-source research via a single mma worker. The worker
consults configured adapters (arxiv, semantic_scholar, github_search) and
— when Brave keys are configured — escalates to Brave web search with `site:`
filters. The worker is bibliographic: it returns a numbered narrative with a
`## Sources used` table. It does not opinion or rank.

**Core principle:** External research is labor (search, fetch, summarise).
Delegate it. The main agent stays on judgment — deciding what the citations
mean and which directions to pursue.

## When to Use

**Use when:**
- "What's the state of the art for X?"
- "Who has published on Y?"
- "What's prior art for Z?"
- The question is external (web, papers, github topics) — not your codebase.

**Don't use when:**
- The question is about THIS codebase → `mma:investigate`
- You need divergent ideation across both internal and external (multiple
  directions with synthesis) → `mma:explore` (orchestrates mma:investigate + mma:research + mma:journal-recall → writes `exploration.md`)
- A single web fetch is all you need → `WebFetch` inline

## Dispatch

Call the `mma_run` MCP tool with `cwd` and a `request` body (below). If the `mma_run` MCP tool
is not available in this session, run `mma clients`.

## Configuration prerequisites

The `mma:research` worker integrates with Semantic Scholar to search academic papers. This adapter is optional but recommended for comprehensive peer-reviewed source coverage.

**Required environment variable:**

```bash
export SEMANTIC_SCHOLAR_API_KEY="your-key-from-semanticscholar.org"
```

Obtain a free API key from [Semantic Scholar API](https://www.semanticscholar.org/product/api).

**Degraded behavior:**

If the Semantic Scholar API key is not configured:
- The worker continues with available adapters (arxiv, github_search, brave-search)
- Semantic Scholar queries are skipped without errors
- Research completes successfully but may lack academic-paper coverage
- No failure occurs; graceful fallback is automatic

## Request body

```json
{
  "type": "research",
  "prompt": "What approaches exist for streaming JSON parsing under 100KB? We currently use a single-pass push parser; we want to evaluate alternatives.",
  "contextBlockIds": []
}
```

| Field | Type | Required | Notes |
|---|---|---|---|
| `prompt` | string | yes | 20+ chars — the research question; context can be inline or via contextBlockIds |
| `contextBlockIds` | string[] | no | IDs from `mma:context-blocks` (max 2) for large background context |

> Worker tier defaults to `complex`. Send `agentTier` to override if needed.

The research criteria target primary-source preference, practitioner consensus, recency, counter-perspectives, and cross-domain analogues — the worker is bibliographic, not opinionated.

## Full example

Call `mma_run` with:

```json
{ "cwd": "/project", "request": { "type": "research", "prompt": "State-of-the-art SIMD JSON parsers under 100KB? We use a single-pass push parser; want SIMD alternatives." } }
```

## Response shapes

### mma_run — dispatch

Short tasks return the terminal envelope (below) inline, in the tool result. Longer-running
tasks return a handle instead:

```json
{ "executionId": "<uuid>", "type": "<route>", "cwd": "<abs path>" }
```

Use `executionId` to poll with `mma_execution_get` / `mma_execution_wait`.

### mma_execution_get / mma_execution_wait — poll

A still-running execution returns identity plus progress (`status: "running"`, `phase`,
`elapsedMs`, `runningHeadline`, …) — not the shape below. A terminal execution returns the
full envelope — these 5 top-level fields:

```json
{
  "execution": {
    "executionId": "<uuid>",
    "type": "<route>",
    "subtype": "<subtype or absent>",
    "status": "completed | done_with_concerns | failed | cancelled",
    "sessions": { "implementer": "<session-id>", "reviewer": "<session-id or null>" },
    "worktree": null,
    "dirtyAtDispatch": false
  },
  "output": {
    "summary": { /* refiner JSON — shape varies by route, see below */ },
    "filesChanged": ["src/foo.ts", "src/bar.ts"],
    "contextBlockId": "<string or null>",
    "reviewerNote": null
  },
  "metrics": {
    "totalDurationMs": 12400,
    "totalCostUsd": 0.08,
    "implementer": { "durationMs": 8000, "costUsd": 0.05, "usage": { "inputTokens": 1200, "outputTokens": 800, "cachedReadTokens": 0, "cachedNonReadTokens": 0 } },
    "reviewer":     { "durationMs": 4000, "costUsd": 0.03, "usage": { "inputTokens": 900, "outputTokens": 400, "cachedReadTokens": 0, "cachedNonReadTokens": 0 } }
  },
  "raw": {
    "implementer": "<raw text output>",
    "reviewer": "<raw text output or null>"
  },
  "error": null
}
```

`execution` is the ONE merged top-level section — there is no separate `task` section. It
carries the execution's own identity (`executionId`, `type`, `status`) alongside what used to
live in a distinct `execution` block (`sessions`, `worktree`, `dirtyAtDispatch`). `subtype`
(audit's criteria set) is optional — read it defensively.

### How to read the envelope

**Step 1 — check `error`:**

| Shape | Meaning |
|---|---|
| `error` is `null` | Task succeeded — read `output` |
| `error` is `{ "code": "...", "message": "..." }` | Task failed — read `error.code` + `error.message` |

**Step 2 — extract the result from `output.summary`:**

`output.summary` is the **parsed JSON** from the refiner (reviewer). Its internal shape varies by route — see the per-skill "Reading the output" section for the exact fields. Common patterns:

| Route family | What `output.summary` contains |
|---|---|
| Read routes (audit, review, investigate, debug, research) | `{ findings: [...], criteriaCovered: [...], ... }` — findings array is the main payload |
| Write routes (delegate, execute_plan) | `{ status: 'done'\|'failed', notes }` or `{ tasks: [...], notes }` |
| Spec / Plan | `{ specPath, sections, acceptanceCriteriaCount, notes }` or `{ planPath, taskCount, tasks, notes }` |
| Journal recall | `{ answer, criteriaCovered, findings: [{ weight, category, claim, evidence, topic, fallback, nodeId, nodePath }] }` |
| Journal record | `{ recorded: [...], failed: [...] }` |

**Step 3 — for read routes, extract findings:**

```
response.output.summary.findings   ← the findings array
response.output.summary.findings[i].weight      ← "critical" | "high" | "medium" | "low"
response.output.summary.findings[i].category
response.output.summary.findings[i].claim       ← one-sentence summary
response.output.summary.findings[i].evidence    ← grounding text
response.output.summary.findings[i].suggestion  ← fix recommendation (some routes omit this)
```

**Step 4 — for write routes, read files changed:**

```
response.output.filesChanged       ← array of relative paths modified by the worker
response.output.contextBlockId     ← non-null for read routes (reusable in contextBlockIds)
```

**Step 5 — check `output.reviewerNote` (reviewer availability):**

`output.reviewerNote` is `null` on the normal path. When the reviewer ran but its output
couldn't be parsed, the task degrades to `status: "done_with_concerns"` with **`error: null`**
(a reviewer format flake is a concern, not a failure), and `output.summary` falls back to the
**implementer's** answer. `reviewerNote` then carries the reason:

```json
"reviewerNote": { "code": "reviewer_unavailable", "message": "<why the parse failed>" }
```

Treat a non-null `reviewerNote` as advisory: the answer in `output.summary` is the un-refined
implementer output, still usable. Never discard the task on `reviewerNote` alone.

### Common extraction mistakes

❌ **Reading `output.findings`** — this field does NOT exist. Findings are inside `output.summary.findings`.

❌ **Reading `results` or `structuredReport`** — these are legacy field names from older API versions. The current envelope uses `output.summary`.

❌ **Treating `output.summary` as a string** — it is parsed JSON (an object), not a string. If it looks like a string, the underlying output could not be parsed at all — check `output.reviewerNote` and, as a last resort, `raw.implementer`.

❌ **Ignoring `error: null` check** — a `status: "done_with_concerns"` task has `error: null` and is a success (advisory concerns only). Only `error !== null` is a failure. In particular, when a reviewer emits non-JSON, the task is `done_with_concerns` with `error: null`, `output.summary` holds the implementer answer, and `output.reviewerNote` explains the degrade — do NOT treat this as a failure.

### Tool call error

A malformed or unresolvable call (bad `cwd`, unknown `executionId`, failed admission) surfaces as an
MCP tool error rather than a terminal envelope — the tool result carries `isError: true` and this
payload:

```json
{ "error": { "code": "<code>", "message": "<human-readable>" } }
```

This is a different signal than Step 1 above: it means the call itself could not be admitted or
resolved, not that a dispatched task ran and failed. A dispatched task's failure always shows up
in the terminal envelope's `error` field instead.


## Terminal context block

Every completed **read-route** task (audit / review / debug / investigate / research) auto-registers a reusable terminal context block containing its report (headline + findings). The block id is returned on the result as **`contextBlockId`**. Write routes (delegate / execute-plan) return `contextBlockId: null` — their record is the commit, not a block. This block is immutable, lives for the session duration, and counts against the project's `maxEntries` quota (default 500).

Use it for delta follow-ups — feed prior results' block ids into a later call's `contextBlockIds`, filtering out nulls:

    contextBlockIds: priorResults.map(r => r.contextBlockId).filter((id) => id !== null)

## Best practices

- Keep `prompt` topical (keywords, not full sentences).
- For large background context, register it via `mma:context-blocks` and pass `contextBlockIds`.
- For multi-round research, register the previous round's findings via
  `mma:context-blocks` and pass `contextBlockIds`.

## Common pitfalls

❌ **Asking a codebase question here.** External adapters can't grep your repo. **Fix:** use `mma:investigate`.

❌ **Inlining the user's full question verbatim.** Multi-sentence excerpts produce poor adapter queries. **Fix:** the worker re-phrases internally; you just pass the question and let it work.

❌ **Expecting opinionated output.** This worker reports what's out there with citations. Ranking and synthesis happen elsewhere — in `mma:explore` or in your own judgment. **Fix:** if you need ranked options, use `mma:explore`.

## Outcome semantics

**Success vs failure:** Check `error` in the terminal envelope. `error === null` means the task succeeded — read `output.summary`. `error !== null` (with `code` + `message`) means it failed.

**Empty findings is not a failure.** Research that finds nothing is a success — "I searched widely and found nothing." The `output.summary.answer` field contains the narrative; `output.summary.findings` contains individual sources with `url` and `source` fields for citation.
