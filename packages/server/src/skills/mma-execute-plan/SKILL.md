---
name: mma-execute-plan
description: Implement tasks from a plan or spec file on disk. Task descriptors match plan headings; tasks run in parallel.
when_to_use: When you have a written plan or spec file and want sub-agents to implement specific tasks from it.
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
BATCH=$(curl -sf -X POST \
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
