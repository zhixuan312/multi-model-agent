---
name: mma-retry
description: Re-run specific failed or incomplete tasks from a previous mmagent batch by index. Preserves the original task specs and only re-executes the named indices.
when_to_use: A previous mma-delegate / mma-execute-plan batch returned partial results and you want to re-try the failed indices only. Prefer this over redispatching the whole batch or inline-retrying — it's idempotent and keeps the original batch's diagnostics intact.
version: "0.0.0-unreleased"
---

## mma-retry

Re-run selected tasks from a completed or failed batch. Specify the original
`batchId` and the zero-based indices of the tasks to re-run. The retry runs
those tasks fresh with the same configuration as the original batch.

### Endpoint

`POST /retry?cwd=<abs-path>`

@include _shared/auth.md

### Request body

```json
{
  "batchId": "550e8400-e29b-41d4-a716-446655440000",
  "taskIndices": [1, 3]
}
```

| Field | Type | Required | Notes |
|---|---|---|---|
| `batchId` | string (UUID) | yes | Batch ID from a previous dispatch |
| `taskIndices` | number[] | yes | Zero-based indices to re-run |

`taskIndices` must be non-negative integers. To re-run all tasks, pass all
indices from `0` to `tasks.length - 1`.

### Full example

```bash
# Original batch had 4 tasks; re-run tasks at index 1 and 3
BATCH=$(curl -f --show-error -s -X POST \
  -H "Authorization: Bearer $TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"batchId":"550e8400-e29b-41d4-a716-446655440000","taskIndices":[1,3]}' \
  "http://localhost:$PORT/retry?cwd=/project")
BATCH_ID=$(echo "$BATCH" | jq -r '.batchId')
```

The retry produces a new `batchId`. Poll the new ID until complete:

@include _shared/polling.md

@include _shared/response-shape.md

@include _shared/error-handling.md
