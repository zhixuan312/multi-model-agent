---
name: debug
description: Use when a deliverable is wrong — a test fails, a build breaks, a report shows the wrong figures, a workflow misbehaves — AND narrowing the root cause requires reading files, reproducing the failure, or tracing across multiple modules — the worker investigates so the main agent stays on the hypothesis
when_to_use: A failure has surfaced in a deliverable (test/build/runtime for code; a wrong report, configuration, or process outcome for non-code work) AND you need investigation work — read files, reproduce, trace — OR a systematic-debugging workflow routes its investigation step here. Delegate the read/reproduce/trace; the main agent stays on the hypothesis and the fix.
version: "0.0.0-unreleased"
---

# mma:debug

## Overview

Submit a problem, context, and hypothesis to a worker for focused debugging. The deliverable under
investigation may be code, or it may be a non-code deliverable that produced a wrong result — a
generated report, a workflow configuration, a data pipeline. Unlike `mma:audit` and `mma:review`, all `target.paths` are investigated TOGETHER in a single task (not parallelized per file) — debugging needs cross-file reasoning.

**Core principle:** The hypothesis is judgment (your job). Reading files and reproducing the failure is labor (the worker's job). Pass the hypothesis as input; receive structured findings.

## When to Use

**Use when:**
- A deliverable is wrong — a test fails / build breaks / runtime behavior is unexpected; or a
  report, configuration, or process output is incorrect
- The root cause likely spans 2+ files
- You have a hypothesis to test (or want the worker to suggest one)
- A systematic-debugging workflow routed the investigation here

**Don't use when:**
- The error message points at one file you can read in 30 seconds → just `Read`
- You don't know what's broken yet → use `mma:investigate` first to map the area
- You already know the fix → skip debug, dispatch `mma:delegate` with the fix

## Dispatch

Call the `mma_run` MCP tool with `cwd` and a `request` body (below). If the `mma_run` MCP tool
is not available in this session, run `mma clients`.

## Request body

```json
{
  "type": "debug",
  "prompt": "POST /login returns 500 when password contains special characters",
  "target": {
    "paths": [
      "/project/src/auth/login.ts",
      "/project/src/auth/password.ts"
    ]
  },
  "contextBlockIds": []
}
```

| Field | Type | Required | Notes |
|---|---|---|---|
| `prompt` | string | yes | What is broken (one sentence; concrete symptom, min 1 char) |
| `target.paths` | string[] | no | All files investigated together (cross-file reasoning) |
| `contextBlockIds` | string[] | no | IDs from `mma:context-blocks` (max 2) — e.g. error logs, traces |

> Worker tier defaults to `complex`. Send `agentTier` to override if needed.

## Full example

Call `mma_run` with:

```json
{ "cwd": "/project", "request": { "type": "debug", "prompt": "Tests fail on CI only", "target": { "paths": ["/project/src/config.ts"] } } }
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
    "status": "done | done_with_concerns | failed | cancelled",
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


## Reading the findings

The main agent reads findings from the terminal envelope at `output.summary.findings` (NOT `output.findings` — that field does not exist). `output.summary` is the parsed refiner JSON; findings are nested inside it. Read-only routes like `mma:debug` do not produce commits — `execution.worktree` is always `null`.

### Finding shape

Every finding in `output.summary.findings` has this shape:

| Field | Type | Notes |
|---|---|---|
| `weight` | `'critical' \| 'high' \| 'medium' \| 'low'` | Severity tier. |
| `category` | string | Topical bucket, e.g. `root-cause`, `reproduction`. |
| `claim` | string | One-sentence summary. |
| `evidence` | string | Verbatim from source when grounded. |
| `file` | string or null | File path where the finding was observed. |
| `line` | number or null | Line number in the file. |

`output.summary` also includes an `answer` field with the debug narrative.

## Best practices

This skill is one step in the larger flow described in `multi-model-agent` → "Best practices". Recipes that involve `mma:debug`:

- **Recipe B — Debug-fix-review.** `mma:debug` → `mma:delegate` (apply fix) → `mma:review` with the acceptance criteria in the brief. Strict order. Register the failing test output / reproduction log as a context block before the debug call; reuse it on the review call.

Anti-pattern alert: **`inline-labor-leakage`** (AP2). If you're about to read 3+ files in main context to "understand the bug," that's the labor we delegate — call `mma:debug` with the hypothesis instead.

## Common pitfalls

❌ **Vague problem in `prompt`**
> "The login is broken"

Worker has no symptom to chase. **Fix:** specific reproducer — `"POST /login with body {user:'a@b.c', pass:'café'} returns 500 with 'invalid character' in stderr"`.

❌ **No hypothesis in `prompt`**
The worker explores blindly, often investigates the wrong area first. **Fix:** even a weak hypothesis ("might be encoding-related") narrows the search space.

❌ **Splitting one bug across multiple `mma:debug` calls**
Debug intentionally bundles `target.paths` for cross-file reasoning. Splitting defeats this. **Fix:** one call with all suspect files; if you really have N independent failures, use `mma:delegate` with N tasks.

❌ **Treating `mma:debug` as the fix step**
Debug investigates and proposes; it doesn't necessarily write the fix. **Fix:** if the worker identifies a fix, dispatch `mma:delegate` to implement it (or write it inline if you understand it).

❌ **Skipping when an error message looks self-explanatory**
Often the obvious cause isn't the real one. **Fix:** a 30-second debug pass costs less than a wrong fix that breaks something else.

## Terminal context block

Every completed **read-route** task (audit / review / debug / investigate / research) auto-registers a reusable terminal context block containing its report (headline + findings). The block id is returned on the result as **`contextBlockId`**. Write routes (delegate / execute-plan) return `contextBlockId: null` — their record is the commit, not a block. This block is immutable, lives for the session duration, and counts against the project's `maxEntries` quota (default 500).

Use it for delta follow-ups — feed prior results' block ids into a later call's `contextBlockIds`, filtering out nulls:

    contextBlockIds: priorResults.map(r => r.contextBlockId).filter((id) => id !== null)

**Use cases:**
- Pass debug findings to a downstream `mma:delegate` fix step
- Feed the root-cause analysis into a follow-up `mma:review` with acceptance criteria in the brief
- Carry debug context forward through the debug → fix → review chain

The block is registered server-side at task completion; no caller action is needed to create it. Delete it explicitly via `DELETE /context-blocks/:id` when no longer needed, or let it expire on session teardown.

## Outcome semantics

**Success vs failure:** Check `error` in the terminal envelope. `error === null` means the task succeeded — read `output.summary`. `error !== null` (with `code` + `message`) means it failed.

**Empty findings is not a failure.** A debug session with zero findings is a success — it means "I looked hard and found nothing." Check `output.summary.findings.length === 0`.
