---
name: mma-debug
description: Debug a failure using a structured hypothesis via the local mmagent HTTP service. All provided files are investigated together in a single task on a worker.
when_to_use: A test fails, a build breaks, or behavior is unexpected AND you need to read files, reproduce the failure, or narrow root cause OR a methodology skill (superpowers:systematic-debugging) points at the investigation step. Delegate the read/reproduce/trace work to a mmagent worker so your main context stays focused on the hypothesis and the fix.
version: "0.0.0-unreleased"
---

## mma-debug

Submit a problem, context, and hypothesis to a sub-agent for focused
debugging. Unlike other tools, all `filePaths` are investigated together
in a single task (not parallelised per file).

### Endpoint

`POST /debug?cwd=<abs-path>`

@include _shared/auth.md

### Request body

```json
{
  "problem": "POST /login returns 500 when password contains special characters",
  "context": "Regression introduced in commit abc123; only affects production config",
  "hypothesis": "The bcrypt binding fails on non-ASCII input in the Docker image",
  "filePaths": [
    "/project/src/auth/login.ts",
    "/project/src/auth/password.ts"
  ],
  "contextBlockIds": []
}
```

| Field | Type | Required | Notes |
|---|---|---|---|
| `problem` | string | yes | What is broken |
| `context` | string | no | Background information |
| `hypothesis` | string | no | Initial theory to test |
| `filePaths` | string[] | no | All files investigated together |
| `contextBlockIds` | string[] | no | IDs from `mma-context-blocks` |

### Full example

```bash
BATCH=$(curl -f --show-error -s -X POST \
  -H "Authorization: Bearer $TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"problem":"Tests fail on CI only","hypothesis":"Missing env var","filePaths":["/project/src/config.ts"]}' \
  "http://localhost:$PORT/debug?cwd=/project")
BATCH_ID=$(echo "$BATCH" | jq -r '.batchId')
```

Then poll until complete:

@include _shared/polling.md

@include _shared/response-shape.md

@include _shared/error-handling.md
