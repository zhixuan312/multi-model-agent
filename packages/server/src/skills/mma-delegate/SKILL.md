---
name: mma-delegate
description: Fan out ad-hoc implementation or research tasks to sub-agents in parallel via the local mmagent HTTP service. Tasks run on cheap workers that don't consume your main-model context window.
when_to_use: You have one or more ad-hoc implementation or research tasks WITHOUT a plan file on disk AND mmagent is running. Prefer this over inline Agent dispatches or superpowers:dispatching-parallel-agents — delegated workers are cheaper, parallel-safe, and keep main context free. If a plan file exists, use mma-execute-plan; if the task is an audit/review/verify/debug, prefer the matching mma-* skill instead.
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
| `tasks[].agentType` | `"standard"` / `"complex"` | no | Worker tier. Default `"standard"` (cheap). Pick `"complex"` when the task is ambiguous, touches many files, is security-sensitive, or a prior standard run came back with `filesWritten: 0` / ran out of turns. Complex workers cost more but finish bigger jobs. |
| `tasks[].filePaths` | string[] | no | Files the sub-agent focuses on |
| `tasks[].done` | string | no | Acceptance criteria |
| `tasks[].contextBlockIds` | string[] | no | IDs from `mma-context-blocks` |

### Full example

```bash
BATCH=$(curl -f --show-error -s -X POST \
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
