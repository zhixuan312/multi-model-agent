---
name: mma-execute-plan
description: Execute tasks from a plan or spec file on disk via the local mmagent HTTP service. Delegates to cheap sub-agents that don't consume your main-model context window. Task descriptors match plan headings; tasks run in parallel.
when_to_use: A plan file exists on disk (any markdown with numbered task headings — docs/superpowers/plans/*.md, a TODO list, a spec doc) AND you need to implement one or more tasks from it. Prefer this over inline Agent dispatches or superpowers:subagent-driven-development / superpowers:executing-plans when mmagent is running — delegated workers are cheaper and don't pollute main context. Task descriptors must match the plan headings verbatim.
version: "0.0.0-unreleased"
---

## mma-execute-plan

Dispatch named tasks from a plan file to sub-agents. Task descriptors must
match plan headings (e.g. `"1. Setup database schema"`). All tasks run in
parallel and duplicate descriptors are rejected.

### Endpoint

`POST /execute-plan?cwd=<abs-path>`

@include _shared/auth.md

### Request body

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
| `tasks` | string[] | yes | At least one; must be unique; match plan headings |
| `context` | string | no | Short additional context not in the plan |
| `filePaths` | string[] | no | Plan file + relevant source files |
| `contextBlockIds` | string[] | no | IDs from `mma-context-blocks` |
| `agentType` | `"standard"` / `"complex"` | no | Worker tier. Default `"standard"` (cheap). Switch to `"complex"` for tasks too large for a standard-tier model to finish in the turn budget (reads many files, produces many edits, or the last run came back with `filesWritten: 0`). |
| `verifyCommand` | string[] | no | Commands to run after each plan task completion to verify the work |
| `tasks[].reviewPolicy` | `"full"` / `"spec_only"` / `"diff_only"` / `"off"` | no | Per-task review lifecycle policy when a task is passed as `{ "task": "...", "reviewPolicy": "..." }`. Default `"full"` |

Set `verifyCommand` when the worker can run a deterministic local check after editing, such as `npm test`, `npm run lint`, or a focused package test. Commands run in order after task completion; each string must be non-empty after trimming. Omit it when no reliable command exists.

Set `reviewPolicy: 'diff_only'` when you want a cheaper single-pass review of the produced diff without spec-review rework loops. Use `reviewPolicy: 'full'` for default spec + quality review, `reviewPolicy: 'spec_only'` when quality review is not needed, and `reviewPolicy: 'off'` only for trusted low-risk tasks where verification is enough.

If the batch reaches `awaiting_clarification`, use `mma-clarifications`
to confirm or correct the proposed interpretation.

### Full example

```bash
BATCH=$(curl -f --show-error -s -X POST \
  -H "Authorization: Bearer $TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"tasks":["3. Migrate database schema"],"filePaths":["/project/docs/plan.md"]}' \
  "http://localhost:$PORT/execute-plan?cwd=/project")
BATCH_ID=$(echo "$BATCH" | jq -r '.batchId')
```

Then poll until complete:

@include _shared/polling.md

@include _shared/response-shape.md

@include _shared/error-handling.md
