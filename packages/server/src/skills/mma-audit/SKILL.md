---
name: mma-audit
description: Audit a document, spec, or config for security, performance, correctness, or style issues via the local mmagent HTTP service. Sub-agents run in parallel per file — no context pollution in the main model.
when_to_use: The user asks to audit a document, spec, or config (for security, correctness, performance, or style) OR a methodology skill (superpowers:dispatching-parallel-agents, /security-review) points at an audit task. Delegate via mmagent so the audit runs on independent workers — your main context stays free to synthesize findings.
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
BATCH=$(curl -f --show-error -s -X POST \
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
