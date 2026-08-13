---
name: delegate
description: Use when you have an ad-hoc implementation or research task WITHOUT a plan file on disk and you want it to run on a cheap worker instead of consuming main-context tokens
when_to_use: You have ad-hoc implementation or research tasks (no plan file on disk) AND mma is running. Prefer this over inline Agent dispatches — workers are cheaper and keep main context free. If a plan file exists → use mma:execute-plan. If the task is audit / review / verify / debug / investigate → use the matching specialized skill.
version: "0.0.0-unreleased"
---

# mma:delegate

## Overview

Dispatch a single ad-hoc task to a worker. The request is flat — prompt, target paths, acceptance criteria, and optional context blocks.

**Core principle:** Workers run on cheap providers; the main agent consumes only the structured per-task report. Each request dispatches one task; callers send multiple requests for multiple tasks.

## When to Use

**Use when:**
- An implementation task you want off the main context (send one request per task)
- A research task you'd otherwise spend tokens reading and grepping
- A focused refactor that fits in one prompt
- The task does NOT match audit / review / verify / debug / investigate (those have specialized skills)

**Don't use when:**
- A plan file exists on disk → `mma:execute-plan` (descriptors auto-match plan headings)
- Two sequential tasks that share files → dispatch one after the other (each is a separate request)
- The work needs to read across many files for synthesis only → `mma:investigate` is cheaper (read-only)

## Dispatch

Call the `mma_run` MCP tool with `cwd` and a `request` body (below). If the `mma_run` MCP tool
is not available in this session, run `mma clients`.

## Request body

```json
{
  "type": "delegate",
  "prompt": "Add input validation to the login handler",
  "target": { "paths": ["/project/src/auth/login.ts"] },
  "done": "All inputs validated; unit tests pass",
  "contextBlockIds": ["cb_abc123"],
  "reviewPolicy": "reviewed"
}
```

| Field | Type | Required | Notes |
|---|---|---|---|
| `prompt` | string | yes | The task instruction |
| `target` | object | no | Target scope for the worker |
| `target.paths` | string[] | no | Files the worker focuses on |
| `done` | string | no | Acceptance criteria |
| `contextBlockIds` | string[] | no | IDs from `mma:context-blocks` (max 2) |
| `reviewPolicy` | `"reviewed"` / `"none"` | no | See review-policy snippet below. Default `"reviewed"` |

### `reviewPolicy` — review lifecycle per task

All task types default to `"reviewed"` (two-phase pipeline: implementer + refiner).
Only `orchestrate` forces `"none"`. Callers can override per-request.

For read-only routes (audit, review, debug, investigate, research, journal_recall),
the refiner verifies the implementer's output against source material — checking
citations, evidence accuracy, and completeness. For write routes (delegate,
execute_plan), the refiner also fixes issues directly in the working tree.

| Value | Behavior | Use when |
|---|---|---|
| `"reviewed"` | Two-phase pipeline: implement + review (default) | Default for all types |
| `"none"` | Skip the review stage | Trivially mechanical edits or throwaway scripts where a second-pass reviewer adds nothing |


## Full example

Call `mma_run` with:

```json
{ "cwd": "/project", "request": { "type": "delegate", "prompt": "Refactor utils.ts to remove dead code", "target": { "paths": ["/project/src/utils.ts"] } } }
```

## Response shapes

`mma_run` returns either the terminal envelope inline (short tasks) or a `{ executionId, type, cwd }`
handle for longer ones — poll with `mma_execution_get`, block with `mma_execution_wait`, cancel with
`mma_execution_cancel`. See `_shared/response-shape.md` below for the full envelope shape and the
tool call error shape.

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
    "practice": "<practice or absent>",
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
(audit's criteria set) and `practice` (the retained software technique for
plan/execute_plan/review/debug) are mutually exclusive and both optional — read them
defensively.

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


## Best practices

This skill is one step in the larger flow described in `multi-model-agent` → "Best practices". Recipes that involve `mma:delegate`:

- **Recipe A (the fix step).** Between audit rounds, `mma:delegate` applies the fix when the change is more than 1-2 lines. Register the spec/audit findings as a context block; pass via `contextBlockIds`.
- **Recipe B (the apply-fix step).** After `mma:debug` returns a hypothesis, `mma:delegate` applies the fix. Same context block carries forward to a follow-up `mma:review` if you want acceptance-criteria checking.

Anti-pattern alert: **`inline-labor-leakage`** (AP2). If you're reading 3+ files or grepping in main context before dispatching, you're paying flagship-model tokens for labor. Pass the file paths to `mma:delegate` and let the worker read.

## Common pitfalls

❌ **Two delegate calls writing the same file concurrently**

Workers run concurrently and race on the file. **Fix:** dispatch sequentially, or merge into one prompt.

❌ **Re-inlining large content across calls**
N calls × 50KB = N transmissions. **Fix:** register the doc once via `mma:context-blocks`, pass the `contextBlockIds` to each call.

❌ **Reading the worker's diff inline before review**
The reviewer sees the full diff with the original prompt as context. Reading inline burns main-context tokens for no quality gain.

## Terminal context block

Write-route tasks (delegate / execute-plan) do NOT register a terminal context block — their durable record is the commit the engine makes on your branch, plus `output.filesChanged`. The result's `contextBlockId` is always `null` for these routes. Read routes (audit / review / debug / investigate / research) return a non-null `contextBlockId`; see those skills for the delta-follow-up recipe.


## Non-git targets

Delegate always runs **in-place**: it edits the `cwd` you submit, on whatever branch that checkout
already has, under the cwd-only sandbox. The engine never creates a branch or a worktree — **you own
the branch**, so cut and check it out before dispatching.

For a **git** target the engine commits your work on that branch after the worker finishes, and
`output.filesChanged` is measured from that commit (`git diff --name-only`), not self-reported. For a
**non-git** target the in-place edits are simply left on disk and there is no commit, no branch, no
PR. Git is never forced.

Workers may not run git themselves (only `status` / `log` / `diff` / `show` are permitted) — the
engine owns the commit, from outside the worker sandbox.
