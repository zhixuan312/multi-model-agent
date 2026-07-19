---
name: mma-journal-recall
description: Use when you're about to design or attempt something and want to know what THIS project already learned — ask a vague conceptual question (no tags or keywords needed); a read-only worker searches the learnings graph and returns the relevant prior lessons + how they relate. Fire before re-treading ground that may already have been explored. NOT for recording a new learning (mma-journal-record), codebase questions (mma-investigate), or external research (mma-research).
when_to_use: A question about THIS project's learnings, before attempting or designing something — ask a vague conceptual question; skip if recording a new learning, asking the codebase, or researching external docs.
version: "0.0.0-unreleased"
---

# mma-journal-recall

## Overview

Recall relevant project learnings from the journal via a read-only mma worker. The worker reads the learnings graph at `.mma/journal/` and synthesizes answers to vague conceptual queries.

**Core principle:** Recall is retrieval (read, traverse graph, synthesize). Delegate it. The main agent stays on using the results — deciding what to do with the prior lessons.

## When to Use

**Use when:**
- Before attempting something, ask "what have we learned about this?".
- The query is a conceptual question, not an exact file or symbol lookup.
- You want prior learnings + their relationships, not isolated chunks.
- The project has an active journal (started with `mma-journal-record`).

**Don't use when:**
- You're recording a new learning → `mma-journal-record`
- You're asking about the codebase structure → `mma-investigate`
- You're researching external docs/web → `mma-research`
- The journal is empty or not yet initialized

## Endpoint

`POST /task?cwd=<abs-path>`

@include _shared/auth.md

## Request body

```json
{
  "type": "journal_recall",
  "prompt": "what have we learned about dispatch cancellation reliability?",
  "topic": "grouped-dispatch",
  "contextBlockIds": []
}
```

| Field | Type | Required | Notes |
|---|---|---|---|
| `prompt` | string | yes | A conceptual question about prior learnings (min 10 chars). Keep this natural-language, not a keyword list. |
| `topic` | string | no | Optional lowercase-kebab topic filter. Use it when you already know the primary subject and want recall to narrow that slice first. |
| `contextBlockIds` | string[] | no | IDs from `mma-context-blocks` (max 2) — enables follow-up / delta recall |

> Worker tier defaults to `complex`. Send `agentTier` to override if needed.

**Why `prompt` stays conceptual even when `topic` exists:**

❌ `{ "prompt": "dispatch", "topic": "grouped-dispatch" }`
✅ `{ "prompt": "what have we learned about dispatch cancellation reliability?", "topic": "grouped-dispatch" }`

`topic` narrows the subject boundary. `prompt` still tells the worker what kind of lesson to retrieve and synthesize.

## Full example

```bash
RESULT=$(curl -f --show-error -s -X POST \
  -H "X-MMA-Client: $MMA_CLIENT" \
  -H "X-MMA-Main-Model: $MMA_MAIN_MODEL" \
  -H "Authorization: Bearer $TOKEN" \
  -H "Content-Type: application/json" \
  -d '{
    "type":"journal_recall",
    "prompt":"what have we learned about dispatch cancellation reliability?",
    "topic":"grouped-dispatch"
  }' \
  "http://localhost:$PORT/task?cwd=/project")
TASK_ID=$(echo "$RESULT" | jq -r '.taskId')
```

@include _shared/polling.md

@include _shared/response-shape.md

## Best practices

- Use `topic` when you know the exact subsystem you care about.
- Keep `prompt` conceptual so the worker can still rank and synthesize within the topic slice.
- Omit `topic` when you want the worker to infer the likely subject and keep cross-topic fallback open.

## Common pitfalls

❌ **Using recall as codebase search**
> prompt: "where is DispatchCanceller called?"

That's a codebase question. Use `mma-investigate` instead.

❌ **Treating `topic` as a replacement for the prompt**
> `{ "prompt": "grouped-dispatch", "topic": "grouped-dispatch" }`

Keep the question conceptual. `topic` scopes the search; `prompt` tells the worker what answer to synthesize.

## Terminal context block

Every completed **read-route** task (audit / review / debug / investigate / recall / research) auto-registers a reusable terminal context block containing its report (headline + findings). The block id is returned on the result as **`contextBlockId`**. Write routes (delegate / execute-plan / retry / journal-record) return `contextBlockId: null` — their record is the commit, not a block.

Use it for delta follow-ups — feed prior results' block ids into a later call's `contextBlockIds`, filtering out nulls:

    contextBlockIds: priorResults.map(r => r.contextBlockId).filter((id) => id !== null)

**Use cases:**
- Recall round 2: pass round 1's block into round 2's `contextBlockIds` to dig deeper on a specific thread.
- Recall → plan → execute chain: feed recall findings as a context block into `mma-execute-plan` as shared prior context.
- Multi-agent follow-up: capture a recall's block and hand it to another tool chain.

The block is registered server-side at task completion; no caller action is needed to create it. Delete it explicitly via `DELETE /context-blocks/:id` when no longer needed, or let it expire on session teardown.

## Interpreting the result

**Success vs failure:** Check `error` in the terminal envelope. `error === null` means the task succeeded — read `output.summary`. `error !== null` (with `code` + `message`) means it failed.

**Empty journal is not a failure.** A recall that finds nothing relevant is a success — "no prior learnings match that question." The `output.summary.answer` field contains the narrative; `output.summary.findings` contains individual learnings with `nodeId` and `nodePath` for citation.

## Multi-repo mode (parent-aware)

In a parent-aware multi-repo flow, recall searches the **parent** workspace **journal**. Pass
`topic = <repo-slug>` (**lowercase-kebab**) to narrow recall to one repo's learnings; recall still falls
back across topics so a repo filter never starves retrieval. Single-project mode is unchanged.

@include _shared/error-handling.md
