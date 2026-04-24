---
name: mma-review
description: Review code for quality, security, performance, or correctness via the local mmagent HTTP service. Sub-agents run in parallel per file, independent context.
when_to_use: superpowers:requesting-code-review or the /review or /security-review slash commands tell you WHEN to review. This skill is HOW — delegate the actual reviewer pass to mmagent so the review doesn't consume your main-model context. Also use directly whenever you'd otherwise inline-Agent a code-review task.
version: "0.0.0-unreleased"
---

## mma-review

Send code or files to sub-agents for structured review. Each file is reviewed
independently in parallel; results are index-aligned with `filePaths`.

### Endpoint

`POST /review?cwd=<abs-path>`

@include _shared/auth.md

### Request body

```json
{
  "code": "inline code snippet (optional if filePaths given)",
  "focus": ["correctness", "security"],
  "filePaths": ["/project/src/auth/login.ts"],
  "contextBlockIds": []
}
```

| Field | Type | Required | Notes |
|---|---|---|---|
| `code` | string | no | Inline code to review |
| `focus` | string[] | no | Any of `security`, `performance`, `correctness`, `style` |
| `filePaths` | string[] | no | Files to review (parallel) |
| `contextBlockIds` | string[] | no | IDs from `mma-context-blocks` |

Either `code` or `filePaths` (or both) must be provided.

### Full example

```bash
BATCH=$(curl -f --show-error -s -X POST \
  -H "Authorization: Bearer $TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"focus":["security","correctness"],"filePaths":["/project/src/auth/login.ts"]}' \
  "http://localhost:$PORT/review?cwd=/project")
BATCH_ID=$(echo "$BATCH" | jq -r '.batchId')
```

Then poll until complete:

@include _shared/polling.md

@include _shared/response-shape.md

@include _shared/error-handling.md
