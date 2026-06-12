---
name: mma-delegate
description: Use when you have one or more ad-hoc implementation or research tasks WITHOUT a plan file on disk and you want them to run on cheap workers in parallel instead of consuming main-context tokens
when_to_use: You have ad-hoc implementation or research tasks (no plan file on disk) AND mmagent is running. Prefer this over inline Agent dispatches or superpowers:dispatching-parallel-agents — workers are cheaper, parallel-safe, and keep main context free. If a plan file exists → use mma-execute-plan. If the task is audit / review / verify / debug / investigate → use the matching specialized skill.
version: "0.0.0-unreleased"
---

# mma-delegate

## Overview

Dispatch one or more ad-hoc tasks to workers concurrently. Each task is an independent instruction with optional file scope, acceptance criteria, and context blocks.

**Core principle:** Workers run on cheap providers; the main agent consumes only the structured per-task report. Parallelize freely as long as tasks don't write the same files.

## When to Use

**Use when:**
- 2+ unrelated implementation tasks (parallel speedup)
- A research task you'd otherwise spend tokens reading and grepping
- A focused refactor that fits in one prompt
- The task does NOT match audit / review / verify / debug / investigate (those have specialized skills)

**Don't use when:**
- A plan file exists on disk → `mma-execute-plan` (descriptors auto-match plan headings)
- Two tasks write the same file → dispatch sequentially, not in one batch (workers race)
- The work needs to read across many files for synthesis only → `mma-investigate` is cheaper (read-only)

## Endpoint

`POST /task?cwd=<abs-path>`

@include _shared/auth.md

## Request body

```json
{
  "type": "delegate",
  "tasks": [
    {
      "prompt": "Add input validation to the login handler",
      "agentType": "standard",
      "filePaths": ["/project/src/auth/login.ts"],
      "done": "All inputs validated; unit tests pass",
      "contextBlockIds": ["cb_abc123"]
    }
  ]
}
```

| Field | Type | Required | Notes |
|---|---|---|---|
| `tasks` | array | yes | At least one task |
| `tasks[].prompt` | string | yes | The task instruction |
| `tasks[].agentType` | `"standard"` / `"complex"` | no | Worker tier. Default `"standard"`. Pick `"complex"` when the task is ambiguous, security-sensitive, touches many files, or a prior standard run came back with `filesWritten: 0` / hit `incompleteReason: "turn_cap"`. |
| `tasks[].filePaths` | string[] | no | Files the worker focuses on |
| `tasks[].done` | string | no | Acceptance criteria |
| `tasks[].contextBlockIds` | string[] | no | IDs from `mma-context-blocks` |
| `tasks[].reviewPolicy` | `"full"` / `"quality_only"` / `"diff_only"` / `"none"` | no | See review-policy snippet below. Default `"full"` |

@include _shared/review-policy.md

## Full example

```bash
BATCH=$(curl -f --show-error -s -X POST \
  -H "X-MMA-Client: $MMA_CLIENT" \
  -H "X-MMA-Main-Model: $MMA_MAIN_MODEL" \
  -H "Authorization: Bearer $TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"type":"delegate","tasks":[{"prompt":"Refactor utils.ts to remove dead code","filePaths":["/project/src/utils.ts"]}]}' \
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
      { "name": "register-block", "outcome": "skip",    "comment": "register-block does not apply to route=delegate", "durationMs": 0, "costUSD": 0 },
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

`blockId` is not used for the delegate route — it is always `null`, as is `contextBlockId` (write routes register no terminal block). To carry inputs forward, register them explicitly via `mma-context-blocks` and pass `contextBlockIds`.

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

This skill is one step in the larger flow described in `multi-model-agent` → "Best practices". Recipes that involve `mma-delegate`:

- **Recipe A (the fix step).** Between audit rounds, `mma-delegate` applies the fix when the change is more than 1-2 lines. Register the spec/audit findings as a context block; pass via `contextBlockIds`.
- **Recipe B (the apply-fix step).** After `mma-debug` returns a hypothesis, `mma-delegate` applies the fix. Same context block carries forward to a follow-up `mma-review` if you want acceptance-criteria checking.

Anti-pattern alert: **`inline-labor-leakage`** (AP2). If you're reading 3+ files or grepping in main context before dispatching, you're paying flagship-model tokens for labor. Pass the file paths to `mma-delegate` and let the worker read.

## Common pitfalls

❌ **Two tasks writing the same file in one batch**
> tasks: [{prompt:"add JWT to login.ts"}, {prompt:"add logging to login.ts"}]

Workers run concurrently and race on the file. **Fix:** dispatch sequentially, or merge into one prompt.

❌ **Two tasks writing the same file in one batch**
N tasks × 50KB = N transmissions. **Fix:** register the doc once via `mma-context-blocks`, pass the `contextBlockIds` to each task.

❌ **Reading the worker's diff inline before review**
The reviewer sees the full diff with the original prompt as context. Reading inline burns main-context tokens for no quality gain.

## Terminal context block

Write-route tasks (delegate / execute-plan / retry) do NOT register a terminal context block — their durable record is the commit (`commitSha` + changed files). The per-task result's `contextBlockId` is always `null` for these routes. Read routes (audit / review / debug / investigate / research) return a non-null `contextBlockId`; see those skills for the delta-follow-up recipe.


@include _shared/error-handling.md
