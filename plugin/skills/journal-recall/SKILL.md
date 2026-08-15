---
name: journal-recall
description: Use when you're about to design or attempt something and want to know what THIS project already learned — ask a vague conceptual question (no tags or keywords needed); a read-only worker searches the learnings graph and returns the relevant prior lessons + how they relate. Fire before re-treading ground that may already have been explored. NOT for recording a new learning (mma:journal-record), codebase questions (mma:investigate), or external research (mma:research).
when_to_use: A question about THIS project's learnings, before attempting or designing something — ask a vague conceptual question; skip if recording a new learning, asking the codebase, or researching external docs.
version: "0.0.0-unreleased"
---

# mma:journal-recall

## Overview

Recall relevant project learnings from the journal via a read-only mma worker. The worker reads the learnings graph at `.mma/journal/` and synthesizes answers to vague conceptual queries.

**Core principle:** Recall is retrieval (read, traverse graph, synthesize). Delegate it. The main agent stays on using the results — deciding what to do with the prior lessons.

## When to Use

**Use when:**
- Before attempting something, ask "what have we learned about this?".
- The query is a conceptual question, not an exact file or symbol lookup.
- You want prior learnings + their relationships, not isolated chunks.
- The project has an active journal (started with `mma:journal-record`).

**Don't use when:**
- You're recording a new learning → `mma:journal-record`
- You're asking about the codebase structure → `mma:investigate`
- You're researching external docs/web → `mma:research`
- The journal is empty or not yet initialized

## Dispatch

Call the `mma_run` MCP tool with `cwd` and a `request` body (below). If the `mma_run` MCP tool
is not available in this session, run `mma clients`.

## Request body

```json
{
  "type": "journal_recall",
  "prompt": "what have we learned about dispatch cancellation reliability?",
  "topic": "grouped-dispatch",
  "contextBlockIds": []
}
```

| Field | Type | Required | Notes |
|---|---|---|---|
| `prompt` | string | yes | A conceptual question about prior learnings (min 10 chars). Keep this natural-language, not a keyword list. |
| `topic` | string | no | Optional lowercase-kebab topic filter. Use it when you already know the primary subject and want recall to narrow that slice first. |
| `contextBlockIds` | string[] | no | IDs from `mma:context-blocks` (max 2) — enables follow-up / delta recall |
| `includeHistory` | boolean | no | Default `false`, which EXCLUDES superseded nodes. Set `true` when the reversal is the point — "did we try this and drop it?", "why did we move off X?" — because a superseded learning is exactly the record of a decision that was undone, and by default recall hides it. |

> Worker tier defaults to `complex`. Send `agentTier` to override if needed.

**Why `prompt` stays conceptual even when `topic` exists:**

❌ `{ "prompt": "dispatch", "topic": "grouped-dispatch" }`
✅ `{ "prompt": "what have we learned about dispatch cancellation reliability?", "topic": "grouped-dispatch" }`

`topic` narrows the subject boundary. `prompt` still tells the worker what kind of lesson to retrieve and synthesize.

## Full example

Call `mma_run` with:

```json
{ "cwd": "/project", "request": { "type": "journal_recall", "prompt": "what have we learned about dispatch cancellation reliability?", "topic": "grouped-dispatch" } }
```

## Response shapes

### mma_run — dispatch

Short tasks return the terminal envelope (below) inline, in the tool result. Longer-running
tasks return a handle instead:

```json
{ "executionId": "<uuid>", "type": "<route>", "cwd": "<abs path>" }
```

Use `executionId` to poll with `mma_execution_get`, block with `mma_execution_wait`, or stop the
work with `mma_execution_cancel`.

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
    "status": "done | done_with_concerns | failed | cancelled | interrupted",
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

`interrupted` is the fifth terminal status: boot reconciliation writes it when a daemon restart
orthaned a running execution. It carries a non-null `error` with a retryable reason
(`daemon_restarted`), so Step 1 still reads correctly — but a consumer switching on only the other
four hits an unhandled state after any restart.

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
response.output.contextBlockId     ← non-null for READ-ONLY types (audit/review/debug/investigate/
                                     research/journal_recall); null for spec and plan too, which
                                     read but are cwd-only (reusable in contextBlockIds)
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


## Best practices

- Use `topic` when you know the exact subsystem you care about.
- Keep `prompt` conceptual so the worker can still rank and synthesize within the topic slice.
- Omit `topic` when you want the worker to infer the likely subject and keep cross-topic fallback open.

## Common pitfalls

❌ **Using recall as codebase search**
> prompt: "where is DispatchCanceller called?"

That's a codebase question. Use `mma:investigate` instead.

❌ **Treating `topic` as a replacement for the prompt**
> `{ "prompt": "grouped-dispatch", "topic": "grouped-dispatch" }`

Keep the question conceptual. `topic` scopes the search; `prompt` tells the worker what answer to synthesize.

## Terminal context block

Every completed **read-only** task — audit / review / debug / investigate / research / **journal_recall** — auto-registers a reusable terminal context block containing its report (headline + findings). The block id is returned on the result as **`contextBlockId`**. Write routes (delegate / execute-plan / journal-record) return `contextBlockId: null` — their record is the commit, not a block.

Use it for delta follow-ups — feed prior results' block ids into a later call's `contextBlockIds`, filtering out nulls. Note what that filter drops: `spec` and `plan` read rather than write, but they are `cwd-only` because they write their document, so they return `contextBlockId: null` and chaining a plan result by block id silently yields nothing:

    contextBlockIds: priorResults.map(r => r.contextBlockId).filter((id) => id !== null)

**Use cases:**
- Recall round 2: pass round 1's block into round 2's `contextBlockIds` to dig deeper on a specific thread.
- Recall → plan → execute chain: feed recall findings as a context block into `mma:execute-plan` as shared prior context.
- Multi-agent follow-up: capture a recall's block and hand it to another tool chain.

The block is registered server-side at task completion; no caller action is needed to create it. Delete it explicitly via `DELETE /context-blocks/:id` when no longer needed, or let it expire on session teardown.

## Outcome semantics

**Success vs failure:** Check `error` in the terminal envelope. `error === null` means the task succeeded — read `output.summary`. `error !== null` (with `code` + `message`) means it failed.

**Empty journal is not a failure.** A recall that finds nothing relevant is a success — "no prior learnings match that question." The `output.summary.answer` field contains the narrative; `output.summary.findings` contains individual learnings with `nodeId` and `nodePath` for citation.

## Multi-repo mode (parent-aware)

In a parent-aware multi-repo flow, recall searches the **parent** workspace **journal**. Pass
`topic = <repo-slug>` (**lowercase-kebab**) to narrow recall to one repo's learnings; recall still falls
back across topics so a repo filter never starves retrieval. Single-project mode is unchanged.
