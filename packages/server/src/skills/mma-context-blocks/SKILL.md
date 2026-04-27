---
name: mma-context-blocks
description: Use when a document larger than ~2 KB will be referenced by 2+ subsequent mma-* calls — register once, pass the returned ID to each call instead of re-uploading the same content. OR a spec / plan / error log was already inlined into one task and is about to be inlined into a second — register on the second reference, never the third.
when_to_use: A document (spec, plan, codebase summary, prior round's findings, error log) larger than ~2 KB will be referenced by two or more mma-* calls in a row. Register once here, then pass the ID via `contextBlockIds` on mma-delegate / mma-execute-plan / mma-audit / mma-review / mma-verify / mma-debug / mma-investigate. Cheaper and faster than inlining the same content N times.
version: "0.0.0-unreleased"
---

# mma-context-blocks

## Overview

Store large documents once; reference them by ID in subsequent `mma-*` calls via `contextBlockIds`. The service prepends the block content to each task prompt that references the ID — content is transmitted ONCE to the daemon, then reused server-side.

**Core principle:** Without context blocks, the same document is sent N times for N tasks. Blocks transmit once. The savings compound on shared specs, prior-round findings, and codebase summaries.

## When to Use

**Use when:**
- A doc >2 KB will be referenced by ≥2 mma-* calls
- You're running iterative audit/review rounds (round 2 references round 1's findings)
- A spec or design doc is the shared input across N parallel tasks
- A long error log is the context for debug + delegate calls

**Don't use when:**
- The doc is <2 KB and used once → just inline it (registration overhead exceeds savings)
- The doc changes between calls → context blocks are immutable; register a new one
- Single task that doesn't reference any large shared content → no benefit

## Endpoints

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
| `ttlMs` | number | no | Time-to-live in ms; omit for session-scoped (default 1h) |

#### Response (201)

```json
{ "id": "cb_abc123" }
```

Use this `id` as a `contextBlockIds` entry in any `mma-*` skill that supports it.

### Delete a context block

`DELETE /context-blocks/:id?cwd=<abs-path>`

Returns `200 { ok: true }` on success. Returns `409 pinned` if the block is held by one or more active batches — wait for those batches to complete before deleting.

## Full example

```bash
# Register spec document once
ID=$(curl -f --show-error -s -X POST \
  -H "Authorization: Bearer $TOKEN" \
  -H "Content-Type: application/json" \
  -d "{\"content\":$(jq -Rs . < /project/docs/spec.md)}" \
  "http://localhost:$PORT/context-blocks?cwd=/project" | jq -r '.id')

# Reference from N delegate tasks
curl -f --show-error -s -X POST \
  -H "Authorization: Bearer $TOKEN" \
  -H "Content-Type: application/json" \
  -d "{\"tasks\":[
    {\"prompt\":\"Implement section 3 per spec\",\"contextBlockIds\":[\"$ID\"]},
    {\"prompt\":\"Implement section 4 per spec\",\"contextBlockIds\":[\"$ID\"]}
  ]}" \
  "http://localhost:$PORT/delegate?cwd=/project"
```

## Best practices

This skill is the cross-cutting state mechanism described in `multi-model-agent` → "Best practices". Recipes that use context blocks:

- **Recipe A — Audit-iterate-clean.** Register the doc once before round 1; pass round-N's findings block ID into round N+1.
- **Recipe B — Debug-fix-verify.** Register the failing test output / reproduction log before the debug call; reuse on verify.
- **Recipe C — Investigate-plan-execute.** Register the plan file before `mma-execute-plan`.
- **Recipe D — Plan-execute-retry.** No new registration needed — `mma-retry` inherits the original batch's `contextBlockIds`.

Anti-pattern alert: **`re-inlined-shared-content`** (AP3). Pasting the same spec into 5 task prompts costs N× tokens. Register once; pass `contextBlockIds`.

## Common pitfalls

❌ **Inlining the same 50KB spec into every task prompt**
> tasks: [{prompt: "Implement section 3:\n[50KB spec]"}, {prompt: "Implement section 4:\n[50KB spec]"}]

N×50KB transmissions; main context burns through tokens. **Fix:** register the spec once, pass `contextBlockIds: ["cb_xxx"]` to each task.

❌ **Forgetting to delete short-TTL blocks**
Blocks count against the project's context-block quota. **Fix:** explicitly `DELETE` after the dependent batches finish — or set a short `ttlMs` so they self-evict.

❌ **Trying to update a block's content**
Blocks are immutable. **Fix:** register a new block with the new content; switch the `contextBlockIds` to the new ID.

❌ **Deleting a block while a batch still references it**
Returns `409 pinned`. **Fix:** poll the dependent batches to terminal first, then delete.

@include _shared/error-handling.md
