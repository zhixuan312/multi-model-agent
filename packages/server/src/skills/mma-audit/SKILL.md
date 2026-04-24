---
name: mma-audit
description: Audit a document for security, performance, correctness, or style issues. Sub-agents run in parallel per file.
when_to_use: When you need to audit a spec, design doc, or configuration file for correctness, security, style, or performance issues.
version: "0.0.0-unreleased"
---

## mma-audit

Send a document or set of files to sub-agents for structured auditing. Each
file is audited independently in parallel; results are indexed by file.

### Endpoint

`POST /audit?cwd=<abs-path>`

@include _shared/auth.md

### Request body

```json
{
  "document": "inline content to audit (optional if filePaths given)",
  "auditType": "correctness",
  "filePaths": ["/project/docs/spec.md"],
  "contextBlockIds": []
}
```

| Field | Type | Required | Notes |
|---|---|---|---|
| `document` | string | no | Inline document content |
| `auditType` | string \| string[] | yes | `security`, `performance`, `correctness`, `style`, or `general`; or an array of the first four |
| `filePaths` | string[] | no | Files to audit (parallel) |
| `contextBlockIds` | string[] | no | IDs from `mma-context-blocks` |

Either `document` or `filePaths` (or both) must be provided.

### Full example

```bash
BATCH=$(curl -sf -X POST \
  -H "Authorization: Bearer $TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"auditType":"correctness","filePaths":["/project/docs/api-spec.md"]}' \
  "http://localhost:$PORT/audit?cwd=/project")
BATCH_ID=$(echo "$BATCH" | jq -r '.batchId')
```

Then poll until complete:

@include _shared/polling.md

@include _shared/response-shape.md

@include _shared/error-handling.md
