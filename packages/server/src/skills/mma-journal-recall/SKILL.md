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
- The query is a conceptual question ("dispatch cancellation reliability?", "rate-limiting patterns?"), not exact tags or keywords.
- You want prior learnings + their relationships, not isolated chunks.
- The project has an active journal (started with `mma-journal-record`).

**Don't use when:**
- You're recording a new learning → `mma-journal-record` (write route).
- You're asking about the codebase structure → `mma-investigate` (read codebase).
- You're researching external docs/web → `mma-research` / `WebSearch`.
- The journal is empty or not yet initialized.

## Endpoint

`POST /task?cwd=<abs-path>`

@include _shared/auth.md

## Request body

```json
{
  "type": "journal_recall",
  "prompt": "what have we learned about dispatch cancellation reliability?",
  "contextBlockIds": []
}
```

| Field | Type | Required | Notes |
|---|---|---|---|
| `prompt` | string | yes | A vague conceptual question about prior learnings (min 10 chars). No tags or keywords needed. |
| `contextBlockIds` | string[] | no | IDs from `mma-context-blocks` (max 2) — enables follow-up / delta recall |

> Worker tier defaults to `complex`. Send `agentTier` to override if needed.

**Why `prompt` is vague, not keyword-filtered:**

❌ `{ "prompt": "dispatch" }` — too narrow, might miss "cancellation reliability" nodes that don't mention the word "dispatch" in title.
✅ `{ "prompt": "what have we learned about dispatch cancellation reliability?" }` — the worker understands the concept and finds related nodes.

**Why:** the worker traverses the journal's typed graph (supersedes, refines, contradicts, depends-on) and synthesizes across related nodes. Semantic matching is the LLM's job, just like `mma-investigate`.

## Full example

```bash
RESULT=$(curl -f --show-error -s -X POST \
  -H "X-MMA-Client: $MMA_CLIENT" \
  -H "X-MMA-Main-Model: $MMA_MAIN_MODEL" \
  -H "Authorization: Bearer $TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"type":"journal_recall","prompt":"what have we learned about dispatch cancellation reliability?"}' \
  "http://localhost:$PORT/task?cwd=/project")
TASK_ID=$(echo "$RESULT" | jq -r '.taskId')
```

@include _shared/polling.md

@include _shared/response-shape.md

## Best practices

This skill is one step in a larger flow described in `multi-model-agent` → "Best practices". Recipes that involve `mma-journal-recall`:

- **Recipe A — Recall before attempting.** Call `mma-journal-recall` with your question before running `mma-delegate` / `mma-execute-plan` to avoid re-treading prior dead ends.
- **Recipe B — Recall → plan → execute.** `mma-journal-recall` → write a plan based on the learnings → `mma-execute-plan`.
- **Recipe C — Delta follow-up recall.** Feed a prior recall's `contextBlockId` into a follow-up call to dig deeper: `contextBlockIds: [priorResult.contextBlockId]`.

Anti-pattern alert: **Misusing recall as codebase search.** Recall is for the *project's learnings graph*, not the codebase. If you want to search code → `mma-investigate`. If you want to ask the journal → `mma-journal-recall`.

## Common pitfalls

❌ **Using exact tags instead of a conceptual question**
> prompt: "dispatch cancellation"

The worker expects a sentence with context, not keywords. **Fix:** phrase it as a question:
> prompt: "what have we learned about dispatch cancellation and how it interacts with timeouts?"

❌ **Asking about the codebase instead of the journal**
> prompt: "where is DispatchCanceller called?"

That's a codebase question. Use `mma-investigate` instead. Journal recall is for *learnings* stored in `.mma/journal/`, not code.

❌ **Assuming the journal exists**
> prompt: "what do we know about X?"

If the project hasn't used `mma-journal-record`, the journal is empty. The worker will return `not_applicable`. **Fix:** check whether the journal is active in the project first, or start recording learnings with `mma-journal-record`.

## Terminal context block

Every completed **read-route** task (audit / review / debug / investigate / recall / research) auto-registers a reusable terminal context block containing its report (headline + findings). The block id is returned on the result as **`contextBlockId`**. Write routes (delegate / execute-plan / retry / journal-record) return `contextBlockId: null` — their record is the commit, not a block. This block is immutable, lives for the session duration, and counts against the project's `maxEntries` quota (default 500).

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

@include _shared/error-handling.md
