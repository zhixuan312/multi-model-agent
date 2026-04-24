---
name: mma-verify
description: Verify work against a checklist. Sub-agents check each item independently.
when_to_use: When you need to confirm that implemented work meets a set of acceptance criteria or a review checklist before claiming completion.
version: "0.0.0-unreleased"
---

## mma-verify

Submit work product and a checklist to sub-agents for independent verification.
Each checklist item is verified in parallel; results are index-aligned.

### Endpoint

`POST /verify?cwd=<abs-path>`

@include _shared/auth.md

### Request body

```json
{
  "work": "inline description of the work (optional if filePaths given)",
  "checklist": [
    "All public functions have JSDoc comments",
    "No console.log statements remain",
    "Unit tests cover the happy path and at least one error case"
  ],
  "filePaths": ["/project/src/utils.ts"],
  "contextBlockIds": []
}
```

| Field | Type | Required | Notes |
|---|---|---|---|
| `work` | string | no | Inline work product description |
| `checklist` | string[] | yes | At least one item |
| `filePaths` | string[] | no | Files to verify against (parallel) |
| `contextBlockIds` | string[] | no | IDs from `mma-context-blocks` |

### Full example

```bash
BATCH=$(curl -sf -X POST \
  -H "Authorization: Bearer $TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"checklist":["Error handler exists","Tests pass"],"filePaths":["/project/src/handler.ts"]}' \
  "http://localhost:$PORT/verify?cwd=/project")
BATCH_ID=$(echo "$BATCH" | jq -r '.batchId')
```

Then poll until complete:

@include _shared/polling.md

@include _shared/response-shape.md

@include _shared/error-handling.md
