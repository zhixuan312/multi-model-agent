---
name: mma-delegate
description: Fan out ad-hoc implementation or research tasks to sub-agents in parallel. Use when there is no plan file on disk.
when_to_use: When you need to delegate one or more implementation or research tasks to sub-agents without a pre-existing plan file. Each task runs in parallel.
version: "0.0.0-unreleased"
---

## mma-delegate

Dispatch one or more tasks to sub-agents concurrently. Each task is an
independent instruction with optional file scope, acceptance criteria, and
context block references.

### Endpoint

`POST /delegate?cwd=<abs-path>`

@include _shared/auth.md

### Request body

```json
{
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
| `tasks[].agentType` | string | no | `standard` (default) or `complex` |
| `tasks[].filePaths` | string[] | no | Files the sub-agent focuses on |
| `tasks[].done` | string | no | Acceptance criteria |
| `tasks[].contextBlockIds` | string[] | no | IDs from `mma-context-blocks` |

Use `agentType: "complex"` for ambiguous scope or security-sensitive tasks.

### Full example

```bash
BATCH=$(curl -sf -X POST \
  -H "Authorization: Bearer $TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"tasks":[{"prompt":"Refactor utils.ts to remove dead code","filePaths":["/project/src/utils.ts"]}]}' \
  "http://localhost:$PORT/delegate?cwd=/project")
BATCH_ID=$(echo "$BATCH" | jq -r '.batchId')
```

Then poll until complete:

@include _shared/polling.md

@include _shared/response-shape.md

@include _shared/error-handling.md
