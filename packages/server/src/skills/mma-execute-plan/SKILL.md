---
name: mma-execute-plan
description: Use when a plan or spec file exists on disk (any markdown with numbered task headings — docs/superpowers/plans/*.md, a TODO list, a spec doc) and you need to implement one or more tasks from it on cheap workers in parallel
when_to_use: A plan file exists on disk AND you need to implement one or more tasks from it AND mmagent is running. Prefer this over inline Agent dispatches or superpowers:subagent-driven-development / superpowers:executing-plans — workers are cheaper and don't pollute main context. Task descriptors must match plan headings verbatim.
version: "0.0.0-unreleased"
---

# mma-execute-plan

## Overview

Dispatch named tasks from a plan file to workers. Each `taskDescriptors` string must match a heading in the plan verbatim (e.g. `"1. Setup database schema"`). All tasks run in parallel; duplicate descriptors are rejected.

**Core principle:** The plan IS the prompt. Workers re-read the plan file in-process and find their named task — you don't need to inline the task body.

## When to Use

**Use when:**
- A plan/spec markdown exists with numbered task headings
- You want to dispatch a subset (or all) of those tasks
- Tasks are mostly independent (parallel-safe)

**Don't use when:**
- No plan file → `mma-delegate` (pass the prompt directly)
- Tasks form a hard linear sequence (later tasks depend on earlier ones' outputs) → dispatch in order, one batch each
- The "plan" is in conversation only, not on disk → write it to disk first, or use `mma-delegate`

## Endpoint

`POST /task?cwd=<abs-path>`

@include _shared/auth.md

## Request body

```json
{
  "type": "execute_plan",
  "taskDescriptors": [
    "1. Add input validation to login handler",
    "2. Write unit tests for the auth module"
  ],
  "filePaths": [
    "/project/docs/plan.md"
  ],
  "contextBlockIds": []
}
```

| Field | Type | Required | Notes |
|---|---|---|---|
| `taskDescriptors` | string[] | yes | At least one; must be unique; each string matches a plan heading verbatim |
| `filePaths` | string[] | yes | EXACTLY one entry: the plan markdown file. Source files belong in `contextBlockIds` (registered via `mma-context-blocks`) so workers can grep them on demand without re-inlining into every worker prompt |
| `contextBlockIds` | string[] | no | IDs from `mma-context-blocks` — the right place for source files referenced by the plan |
| `perTaskReviewPolicy` | `Record<string, 'full'\|'quality_only'\|'diff_only'\|'none'>` | no | Per-task-index review policy override. Key = task index as string (`"0"`, `"1"`, ...). Default per task: `"full"` |
| `cwd` | string | no | Override the `?cwd=` query param value at the body level (rare; usually pass via query) |

@include _shared/review-policy.md

> **No `agentType` here.** Worker tier is hardcoded to `standard` for every plan task; sending `agentType` (top-level or per-task) is rejected with HTTP 400. For tasks that need `complex` tier, dispatch via `mma-delegate` with the plan task as the prompt and `agentType: "complex"`.

## Full example

```bash
BATCH=$(curl -f --show-error -s -X POST \
  -H "X-MMA-Client: $MMA_CLIENT" \
  -H "X-MMA-Main-Model: $MMA_MAIN_MODEL" \
  -H "Authorization: Bearer $TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"type":"execute_plan","taskDescriptors":["3. Migrate database schema"],"filePaths":["/project/docs/plan.md"]}' \
  "http://localhost:$PORT/task?cwd=/project")
BATCH_ID=$(echo "$BATCH" | jq -r '.batchId')
```

@include _shared/polling.md

## Response shapes

### POST /task?cwd=<abs> — dispatch response (202)

```json
{ "batchId": "<uuid>", "statusUrl": "/batch/<uuid>" }
```

Use `batchId` to poll. `statusUrl` is a convenience pointer.

### GET /batch/:id — polling response

The HTTP status is the state discriminator:

| Status | Meaning |
|---|---|
| `202 text/plain` | Still pending — body is the running headline string |
| `200 application/json` | Terminal — body is the batch envelope below |
| `404` / `401` / `5xx` | Error — see Error response below; stop polling |

### GET /batch/:id?taskIndex=N — single task slice

Same envelope. `results` contains exactly the task at index `N`. Returns `404 unknown_task_index` if `N` is out of range.

### Reading the task result

Each task result is the per-task wire object (`ComposePayload`):

```json
{
  "completed": true,
  "message": "Task completed; tests passed; one file changed.",
  "findings": [
    {
      "id": "F1",
      "severity": "high",
      "category": "correctness",
      "claim": "The function does not handle empty input",
      "evidence": "function foo() { ... } // no null check",
      "suggestion": "Add an explicit null guard at the top",
      "source": "reviewer"
    }
  ],
  "summary": "Refactored utils.ts — removed 3 dead branches, added JSDoc",
  "filesChanged": ["/project/src/utils.ts"],
  "commitSha": "abc123def",
  "blockId": null,
  "telemetry": {
    "totalDurationMs": 12400,
    "totalCostUSD": 0.08,
    "workerSelfAssessment": "done",
    "reviewVerdict": "approved",
    "commitOutcome": "committed",
    "stopReason": "normal",
    "haltedStage": null,
    "stages": [
      { "name": "prepare",        "outcome": "advance", "durationMs": 2,    "costUSD": 0 },
      { "name": "register-block", "outcome": "skip",    "comment": "register-block does not apply to route=execute-plan", "durationMs": 0, "costUSD": 0 },
      { "name": "implement",      "outcome": "advance", "durationMs": 8900, "costUSD": 0.05 },
      { "name": "review",         "outcome": "advance", "durationMs": 2100, "costUSD": 0.02 },
      { "name": "rework",         "outcome": "skip",    "comment": "rework skipped because review approved", "durationMs": 0, "costUSD": 0 },
      { "name": "commit",         "outcome": "advance", "durationMs": 340,  "costUSD": 0 },
      { "name": "annotate",       "outcome": "advance", "durationMs": 890,  "costUSD": 0.01 },
      { "name": "compose",        "outcome": "advance", "durationMs": 68,   "costUSD": 0 },
      { "name": "terminal",       "outcome": "advance", "durationMs": 100,  "costUSD": 0 }
    ]
  }
}
```

**Top-level fields to read for the main-agent verdict:**

| Field | When `true` / populated |
|---|---|
| `completed: true` | Task succeeded. `message` is the summary; `findings` are post-review issues (if any). |
| `completed: false` | Task did not complete. `message` names the blocking gate or finding; `findings` carry any discovered issues. |
| `findings` | Issues surfaced by the worker or reviewer. `severity` = `critical` \| `high` \| `medium` \| `low`. `source` = `implementer` \| `reviewer`. |
| `filesChanged` | File paths modified (empty for read-only routes). |
| `commitSha` | Git SHA of the committed diff; `null` for read-only routes or when commit was skipped. |
| `blockId` | Always `null` (execute-plan is a write route; `contextBlockId` is `null` too — no terminal block). |

**The stages array** (always 9 rows) is the canonical telemetry log. `outcome` is one of:
- `advance` — stage ran and produced its payload
- `skip` — stage did not run; `comment` explains why
- `halt` — stage stopped the chain; `comment` is the failure message
- `not_run` — stage was not reached because a prior stage halted

Use `telemetry.haltedStage` to find the first halt; `telemetry.stopReason` to find why.

### Error response (4xx / 5xx)

```json
{
  "error": "<code>",
  "message": "<human-readable>",
  "details": { /* optional structured context, e.g. fieldErrors for 400 */ }
}
```

`details` is optional and present only when the server has structured additional context.

## Best practices

This skill is one step in the larger flow described in `multi-model-agent` → "Best practices". Recipes that involve `mma-execute-plan`:

- **Recipe C — Investigate-plan-execute.** `mma-investigate` → write the plan → `mma-execute-plan` → `mma-retry` on failed indices. Register the plan file as a context block before the execute-plan call so it isn't re-inlined into every worker's prompt; retry inherits the same configuration.
- **Recipe D — Plan-execute-retry (entry point).** `mma-execute-plan` is the producer of the `batchId` that `mma-retry` consumes. When this batch returns mixed `done` / `failed`, the next call is `mma-retry` with failed indices, NOT a re-dispatch.

Anti-pattern alert: **`full-batch-redispatch`** (AP4). When the batch returns mixed `done` / `failed`, do NOT re-run the whole task list — use `mma-retry` with the failed indices only. Re-running the whole list re-charges every successful task.

## Common pitfalls

❌ **Task descriptor doesn't match plan heading verbatim**
> taskDescriptors: ["Migrate db schema"]    ← plan heading is "3. Migrate database schema"

Worker rejects with "no matching task" or matches the wrong one. **Fix:** copy the heading from the plan, including the leading number.

❌ **Forgetting the plan file in `filePaths`**
> filePaths: ["/project/src/db/schema.sql"]    ← no plan file

Worker can't read the task body. **Fix:** always include the plan path: `filePaths: ["/project/docs/plan.md", "/project/src/db/schema.sql"]`.

❌ **Dispatching dependent tasks in one batch**
Task 5 depends on Task 4's output → workers race; Task 5 might run before Task 4 finishes. **Fix:** dispatch Task 4, wait for terminal, then dispatch Task 5.

## Terminal context block

Write-route tasks (delegate / execute-plan / retry) do NOT register a terminal context block — their durable record is the commit (`commitSha` + changed files). The per-task result's `contextBlockId` is always `null` for these routes. Read routes (audit / review / debug / investigate / research) return a non-null `contextBlockId`; see those skills for the delta-follow-up recipe.


@include _shared/error-handling.md
