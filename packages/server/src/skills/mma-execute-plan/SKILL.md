---
name: mma-execute-plan
description: Execute tasks from a plan or spec file on disk via the local mmagent HTTP service. Delegates to cheap sub-agents that don't consume your main-model context window. Task descriptors match plan headings; tasks run in parallel.
when_to_use: You have a plan file (docs/superpowers/plans/*.md or any markdown with numbered task headings) and need to implement one or more tasks. Prefer this over inline Agent dispatches or superpowers:subagent-driven-development whenever mmagent is running on localhost — delegated workers are cheaper and don't pollute main context.
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
  "contextBlockIds": []
}
```

| Field | Type | Required | Notes |
|---|---|---|---|
| `tasks` | string[] | yes | At least one; must be unique; match plan headings |
| `context` | string | no | Short additional context not in the plan |
| `filePaths` | string[] | no | Plan file + relevant source files |
| `contextBlockIds` | string[] | no | IDs from `mma-context-blocks` |

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
