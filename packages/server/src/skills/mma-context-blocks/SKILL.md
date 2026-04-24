---
name: mma-context-blocks
description: Register large reused documents as context blocks and reference them by ID across multiple tool calls. Avoids re-sending the same content repeatedly.
when_to_use: When the same large document (spec, plan, codebase summary) needs to be referenced by multiple mma-* calls. Register once, reference by ID.
version: "0.0.0-unreleased"
---

## mma-context-blocks

Store large documents once; reference them by ID in subsequent `mma-*` calls
via `contextBlockIds`. The service prepends the block content to each task
prompt that references it.

### Register a context block

`POST /context-blocks?cwd=<abs-path>`

@include _shared/auth.md

#### Request body

```json
{
  "content": "# Project spec\n...",
  "ttlMs": 3600000
}
```

| Field | Type | Required | Notes |
|---|---|---|---|
| `content` | string | yes | Document content (min 1 char) |
| `ttlMs` | number | no | Time-to-live in ms; omit for session-scoped |

#### Response (201)

```json
{ "id": "cb_abc123" }
```

Use this `id` as a `contextBlockIds` entry in `mma-delegate`, `mma-audit`,
`mma-review`, `mma-verify`, `mma-debug`, or `mma-execute-plan`.

### Delete a context block

`DELETE /context-blocks/:id?cwd=<abs-path>`

Returns `200 { ok: true }` on success.

Returns `409 pinned` if the block is held by one or more active batches —
wait for those batches to complete before deleting.

### Example

```bash
# Register spec document
ID=$(curl -sf -X POST \
  -H "Authorization: Bearer $TOKEN" \
  -H "Content-Type: application/json" \
  -d "{\"content\":$(jq -Rs . < /project/docs/spec.md)}" \
  "http://localhost:$PORT/context-blocks?cwd=/project" | jq -r '.id')

# Use in a delegate call
curl -sf -X POST \
  -H "Authorization: Bearer $TOKEN" \
  -H "Content-Type: application/json" \
  -d "{\"tasks\":[{\"prompt\":\"Implement per spec\",\"contextBlockIds\":[\"$ID\"]}]}" \
  "http://localhost:$PORT/delegate?cwd=/project"
```

@include _shared/error-handling.md
