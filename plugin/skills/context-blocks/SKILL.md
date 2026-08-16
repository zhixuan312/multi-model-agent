---
name: context-blocks
description: Use when a document larger than ~2 KB will be referenced by 2+ subsequent mma:* calls — register once, pass the returned ID to each call instead of re-uploading the same content. OR a spec / plan / error log was already inlined into one task and is about to be inlined into a second — register on the second reference, never the third.
when_to_use: A document (spec, plan, codebase summary, prior round's findings, error log) larger than ~2 KB will be referenced by two or more mma:* calls in a row. Register once here, then pass the ID via `contextBlockIds` on mma:delegate / mma:execute-plan / mma:audit / mma:review / mma:debug / mma:investigate. Cheaper and faster than inlining the same content N times.
version: "0.0.0-unreleased"
---

# mma:context-blocks

## Overview

Store large documents once; reference them by ID in subsequent `mma:*` calls via `contextBlockIds`. The service prepends the block content to each task prompt that references the ID — content is transmitted ONCE to the daemon, then reused server-side.

**Core principle:** Without context blocks, the same document is sent N times for N tasks. Blocks transmit once. The savings compound on shared specs, prior-round findings, and codebase summaries.

## When to Use

**Use when:**
- A doc >2 KB will be referenced by ≥2 mma:* calls
- You're running iterative audit/review rounds (round 2 references round 1's findings)
- A spec or design doc is the shared input across N parallel tasks
- A long error log is the context for debug + delegate calls

**Don't use when:**
- The doc is <2 KB and used once → just inline it (registration overhead exceeds savings)
- The doc changes between calls → context blocks are immutable; register a new one
- Single task that doesn't reference any large shared content → no benefit

## Dispatch

Two MCP tools, both scoped to `cwd`. If neither is available in this session, run `mma clients`.

### Register a context block — `mma_context_block_create`

```json
{ "cwd": "/project", "content": "# Project spec\n...", "ttlMs": 3600000 }
```

| Field | Type | Required | Notes |
|---|---|---|---|
| `cwd` | string | yes | Absolute path of the project that will own this block |
| `content` | string | yes | Document content (min 1 char, max **512 KiB** — `server.limits.maxContextBlockBytes`, measured in BYTES not characters) |
| `ttlMs` | number | no | Time-to-live in ms; omit for idle-expiry (default 24 h idle). A block that is not referenced by any active task for 24 h is eligible for eviction. |

Returns `{ "id": "3f2b1c8e-9a41-4d77-b0e2-5c6d8f9a1b23" }`. Use this `id` as a `contextBlockIds` entry in any `mma:*` skill
that supports it.

### Delete a context block — `mma_context_block_delete`

```json
{ "cwd": "/project", "blockId": "3f2b1c8e-9a41-4d77-b0e2-5c6d8f9a1b23" }
```

Succeeds silently, or fails with `pinned` if the block is held by one or more active tasks (wait
for those tasks to complete before deleting) or `not_found` for an unknown id.

## Full example

```json
// Register the spec document once
mma_context_block_create({ "cwd": "/project", "content": "<contents of /project/.mma/specs/2026-07-11-feature-design.md>" })
// -> { "id": "3f2b1c8e-9a41-4d77-b0e2-5c6d8f9a1b23" }

// Reference it from a delegate call
mma_run({ "cwd": "/project", "request": { "type": "delegate", "prompt": "Implement section 3 per spec", "contextBlockIds": ["3f2b1c8e-9a41-4d77-b0e2-5c6d8f9a1b23"] } })
```

## Best practices

This skill is the cross-cutting state mechanism described in `multi-model-agent` → "Best practices". Recipes that use context blocks:

- **Recipe A — Audit-iterate-clean.** Register the doc once before round 1; pass round-N's findings block ID into round N+1.
- **Recipe B — Debug-fix-verify.** Register the failing test output / reproduction log before the debug call; reuse on verify.
- **Recipe C — Investigate-plan-execute.** Register the plan file before `mma:execute-plan`.

Anti-pattern alert: **`re-inlined-shared-content`** (AP3). Pasting the same spec into 5 task prompts costs N× tokens. Register once; pass `contextBlockIds`.

## Common pitfalls

❌ **Inlining the same 50KB spec into every task prompt**
Inlining a 50KB spec into every delegate call's prompt.

N×50KB transmissions; main context burns through tokens. **Fix:** register the spec once, pass `contextBlockIds: ["3f2b1c8e-9a41-4d77-b0e2-5c6d8f9a1b23"]` to each call.

❌ **Forgetting to delete unused blocks**
Blocks count against the project's context-block quota (`server.limits.maxContextBlocksPerProject` 500). **Fix:** explicitly call `mma_context_block_delete` after the dependent tasks finish — or let idle expiry (24 h) evict them.

❌ **Trying to update a block's content**
Blocks are immutable. **Fix:** register a new block with the new content; switch the `contextBlockIds` to the new ID.

❌ **Deleting a block while a task still references it**
Fails with `pinned`. **Fix:** poll the dependent tasks to terminal first, then delete.
