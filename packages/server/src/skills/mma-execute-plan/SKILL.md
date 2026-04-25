---
name: mma-execute-plan
description: Use when a plan or spec file exists on disk (any markdown with numbered task headings — docs/superpowers/plans/*.md, a TODO list, a spec doc) and you need to implement one or more tasks from it on cheap workers in parallel
when_to_use: A plan file exists on disk AND you need to implement one or more tasks from it AND mmagent is running. Prefer this over inline Agent dispatches or superpowers:subagent-driven-development / superpowers:executing-plans — workers are cheaper and don't pollute main context. Task descriptors must match plan headings verbatim.
version: "0.0.0-unreleased"
---

# mma-execute-plan

## Overview

Dispatch named tasks from a plan file to workers. Each `tasks` string must match a heading in the plan verbatim (e.g. `"1. Setup database schema"`). All tasks run in parallel; duplicate descriptors are rejected.

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

`POST /execute-plan?cwd=<abs-path>`

@include _shared/auth.md

## Request body

```json
{
  "tasks": [
    "1. Add input validation to login handler",
    "2. Write unit tests for the auth module"
  ],
  "context": "Tasks 1-5 are complete; auth module already exists at src/auth/",
  "filePaths": [
    "/project/docs/plan.md",
    "/project/src/auth/login.ts"
  ],
  "contextBlockIds": [],
  "agentType": "standard"
}
```

| Field | Type | Required | Notes |
|---|---|---|---|
| `tasks` | string[] \| `{task, reviewPolicy}[]` | yes | At least one; must be unique; each string matches a plan heading |
| `context` | string | no | Short additional context not in the plan |
| `filePaths` | string[] | no | Plan file + relevant source files. Required: the plan file itself. |
| `contextBlockIds` | string[] | no | IDs from `mma-context-blocks` |
| `agentType` | `"standard"` / `"complex"` | no | Default `"standard"`. Use `"complex"` for tasks too large for the standard tier — reads many files, produces many edits, or the last run came back with `filesWritten: 0`. |
| `verifyCommand` | string[] | no | See verify-and-review snippet below |
| `tasks[].reviewPolicy` | `"full"` / `"spec_only"` / `"diff_only"` / `"off"` | no | See verify-and-review snippet below. Default `"full"`. |

@include _shared/verify-and-review.md

If the batch reaches `awaiting_clarification`, use `mma-clarifications` to confirm or correct the proposed interpretation.

## Full example

```bash
BATCH=$(curl -f --show-error -s -X POST \
  -H "Authorization: Bearer $TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"tasks":["3. Migrate database schema"],"filePaths":["/project/docs/plan.md"]}' \
  "http://localhost:$PORT/execute-plan?cwd=/project")
BATCH_ID=$(echo "$BATCH" | jq -r '.batchId')
```

@include _shared/polling.md

@include _shared/response-shape.md

## Common pitfalls

❌ **Task descriptor doesn't match plan heading verbatim**
> tasks: ["Migrate db schema"]    ← plan heading is "3. Migrate database schema"

Worker rejects with "no matching task" or matches the wrong one. **Fix:** copy the heading from the plan, including the leading number.

❌ **Forgetting the plan file in `filePaths`**
> filePaths: ["/project/src/db/schema.sql"]    ← no plan file

Worker can't read the task body. **Fix:** always include the plan path: `filePaths: ["/project/docs/plan.md", "/project/src/db/schema.sql"]`.

❌ **Dispatching dependent tasks in one batch**
Task 5 depends on Task 4's output → workers race; Task 5 might run before Task 4 finishes. **Fix:** dispatch Task 4, wait for terminal, then dispatch Task 5.

❌ **Skipping `verifyCommand` when one exists**
A passing local check is the cheapest signal you're going to get. **Fix:** wire `["npm test"]` or the focused package test.

@include _shared/error-handling.md
