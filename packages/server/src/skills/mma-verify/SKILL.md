---
name: mma-verify
description: Verify work against a checklist via the local mmagent HTTP service. Sub-agents check each item independently.
when_to_use: superpowers:verification-before-completion tells you to produce evidence before claiming done. This skill delegates that evidence-gathering to mmagent workers so it runs in parallel on cheap models. Use whenever you'd otherwise inline-dispatch a checklist verification.
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
BATCH=$(curl -f --show-error -s -X POST \
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
