---
name: mma-execute-plan
description: Use when a plan or spec file exists on disk (any markdown with task headings — .mma/plans/*.md, a TODO list, a spec doc) and you need to implement one or more tasks from it sequentially in one worker session
when_to_use: A plan file exists on disk AND you need to implement one or more tasks from it AND mma is running. Prefer this over inline Agent dispatches or superpowers:subagent-driven-development / superpowers:executing-plans — workers are cheaper and don't pollute main context. Task descriptors must match plan headings verbatim.
version: "0.0.0-unreleased"
---

# mma-execute-plan

## Overview

Dispatch tasks from a plan file to a single worker session. The `tasks` array selects which plan headings to execute — the worker receives them all in one prompt and executes them sequentially in plan order within one worktree. Empty `tasks` = run all.

**Core principle:** The plan IS the prompt. Workers re-read the plan file in-process and find their named task — you don't need to inline the task body.

## When to Use

**Use when:**
- A plan/spec markdown exists with numbered task headings
- You want to dispatch a subset (or all) of those tasks
- Tasks are sequential (later tasks build on earlier ones) — the worker handles ordering

**Don't use when:**
- No plan file → `mma-delegate` (pass the prompt directly)
- The "plan" is in conversation only, not on disk → write it to disk first, or use `mma-delegate`

## Endpoint

`POST /task?cwd=<abs-path>`

@include _shared/auth.md

## Request body

```json
{
  "type": "execute_plan",
  "prompt": "Focus on the backend tasks only",
  "tasks": [
    "1. Add input validation to login handler",
    "2. Write unit tests for the auth module"
  ],
  "target": {
    "paths": ["/project/.mma/plans/2026-07-11-feature.md"]
  },
  "contextBlockIds": []
}
```

| Field | Type | Required | Notes |
|---|---|---|---|
| `prompt` | string | no | Optional caller context for the worker (e.g. "focus on backend tasks", "skip tests") — injected alongside the plan content |
| `tasks` | string[] | no | Task selectors matching plan headings. Empty or omitted = run all tasks in the plan |
| `target.paths` | string[] | yes | EXACTLY one entry: the plan markdown file |
| `contextBlockIds` | string[] | no | IDs from `mma-context-blocks` (max 2) — the right place for source files referenced by the plan |

@include _shared/review-policy.md

> Worker tier defaults to `standard`. Send `agentTier` to override if needed.

## Full example

```bash
RESULT=$(curl -f --show-error -s -X POST \
  -H "X-MMA-Client: $MMA_CLIENT" \
  -H "X-MMA-Main-Model: $MMA_MAIN_MODEL" \
  -H "Authorization: Bearer $TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"type":"execute_plan","tasks":["3. Migrate database schema"],"target":{"paths":["/project/.mma/plans/2026-07-11-feature.md"]}}' \
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

## Natural next step

Tasks are implemented. Usual next moves (soft suggestions — none forced):
- **Review the changes** → `mma-review` on the changed files.
- **Re-run only the failures** → `mma-retry` on any `failed` / incomplete indices (never a full re-dispatch).

## Best practices

This skill is one step in the larger flow described in `multi-model-agent` → "Best practices". Recipes that involve `mma-execute-plan`:

- **Recipe C — Investigate-plan-execute.** `mma-investigate` → write the plan → `mma-execute-plan` → `mma-retry` on failed indices. Register the plan file as a context block before the execute-plan call so it isn't re-inlined into every worker's prompt; retry inherits the same configuration.
- **Recipe D — Plan-execute-retry (entry point).** `mma-execute-plan` is the producer of the `taskId` that `mma-retry` consumes. When this dispatch returns mixed `done` / `failed`, the next call is `mma-retry` with failed indices, NOT a re-dispatch.

Anti-pattern alert: **`full-batch-redispatch`** (AP4). When the dispatch returns mixed `done` / `failed`, do NOT re-run the whole task list — use `mma-retry` with the failed indices only. Re-running the whole list re-charges every successful task.

## Common pitfalls

❌ **Task descriptor doesn't match plan heading verbatim**
> tasks: ["Migrate db schema"]    ← plan heading is "3. Migrate database schema"

Worker rejects with "no matching task" or matches the wrong one. **Fix:** copy the heading from the plan, including the leading number.

❌ **Forgetting the plan file in `target.paths`**
> target.paths: ["/project/src/db/schema.sql"]    ← no plan file

Worker can't read the task body. **Fix:** always include the plan path: `target.paths: ["/project/.mma/plans/2026-07-11-feature.md"]`.

execute_plan handles dependencies naturally since tasks run sequentially in one session — the worker executes them in order within a single worktree.

## Terminal context block

Write-route tasks (delegate / execute-plan / retry) do NOT register a terminal context block — their durable record is the commit (merged worktree branch + `output.filesChanged`). The result's `contextBlockId` is always `null` for these routes. Read routes (audit / review / debug / investigate / research) return a non-null `contextBlockId`; see those skills for the delta-follow-up recipe.


@include _shared/error-handling.md
