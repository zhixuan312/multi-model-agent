---
name: mma-delegate
description: Use when you have an ad-hoc implementation or research task WITHOUT a plan file on disk and you want it to run on a cheap worker instead of consuming main-context tokens
when_to_use: You have ad-hoc implementation or research tasks (no plan file on disk) AND mma is running. Prefer this over inline Agent dispatches or superpowers:dispatching-parallel-agents — workers are cheaper and keep main context free. If a plan file exists → use mma-execute-plan. If the task is audit / review / verify / debug / investigate → use the matching specialized skill.
version: "0.0.0-unreleased"
---

# mma-delegate

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
- A plan file exists on disk → `mma-execute-plan` (descriptors auto-match plan headings)
- Two sequential tasks that share files → dispatch one after the other (each is a separate request)
- The work needs to read across many files for synthesis only → `mma-investigate` is cheaper (read-only)

## Endpoint

`POST /task?cwd=<abs-path>`

@include _shared/auth.md

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
| `contextBlockIds` | string[] | no | IDs from `mma-context-blocks` (max 2) |
| `reviewPolicy` | `"reviewed"` / `"none"` | no | See review-policy snippet below. Default `"reviewed"` |

@include _shared/review-policy.md

## Full example

```bash
RESULT=$(curl -f --show-error -s -X POST \
  -H "X-MMA-Client: $MMA_CLIENT" \
  -H "X-MMA-Main-Model: $MMA_MAIN_MODEL" \
  -H "Authorization: Bearer $TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"type":"delegate","prompt":"Refactor utils.ts to remove dead code","target":{"paths":["/project/src/utils.ts"]}}' \
  "http://localhost:$PORT/task?cwd=/project")
TASK_ID=$(echo "$RESULT" | jq -r '.taskId')
```

@include _shared/polling.md

## Response shapes

### POST /task?cwd=<abs> — dispatch response (202)

```json
{ "taskId": "<uuid>", "statusUrl": "/task/<uuid>" }
```

Use `taskId` to poll. `statusUrl` is a convenience pointer.

### GET /task/:taskId — polling response

The HTTP status is the state discriminator:

| Status | Meaning |
|---|---|
| `202 application/json` | Still pending — body is structured progress JSON: `{ taskId, status, phase, elapsedMs, phaseElapsedMs, startedAt }` |
| `200 application/json` | Terminal — body is the task envelope below |
| `404` / `401` / `5xx` | Error — see Error response below; stop polling |

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

❌ **Two delegate calls writing the same file concurrently**

Workers run concurrently and race on the file. **Fix:** dispatch sequentially, or merge into one prompt.

❌ **Re-inlining large content across calls**
N calls × 50KB = N transmissions. **Fix:** register the doc once via `mma-context-blocks`, pass the `contextBlockIds` to each call.

❌ **Reading the worker's diff inline before review**
The reviewer sees the full diff with the original prompt as context. Reading inline burns main-context tokens for no quality gain.

## Terminal context block

Write-route tasks (delegate / execute-plan / retry) do NOT register a terminal context block — their durable record is the commit (merged worktree branch + `output.filesChanged`). The result's `contextBlockId` is always `null` for these routes. Read routes (audit / review / debug / investigate / research) return a non-null `contextBlockId`; see those skills for the delta-follow-up recipe.


## Non-git targets

When the target `cwd` is **non-git**, delegate runs **in-place** with **no worktree** — it edits the
folder directly under the cwd-only sandbox, and there is no branch/PR/merge. Git targets keep worktree
isolation unchanged. Git is never forced.

@include _shared/error-handling.md
