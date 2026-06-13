---
name: mma-journal-recall
description: Use when you're about to design or attempt something and want to know what THIS project already learned — ask a vague conceptual question (no tags or keywords needed); a read-only worker searches the learnings graph and returns the relevant prior lessons + how they relate. Fire before re-treading ground that may already have been explored. NOT for recording a new learning (mma-journal-record), codebase questions (mma-investigate), or external research (mma-research).
when_to_use: A question about THIS project's learnings, before attempting or designing something — ask a vague conceptual question; skip if recording a new learning, asking the codebase, or researching external docs.
version: "0.0.0-unreleased"
---

# mma-journal-recall

## Overview

Recall relevant project learnings from the journal via a read-only mmagent worker. The worker reads the learnings graph at `.mmagent/journal/` and synthesizes answers to vague conceptual queries.

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
  "query": "what have we learned about dispatch cancellation reliability?",
  "contextBlockIds": []
}
```

| Field | Type | Required | Notes |
|---|---|---|---|
| `query` | string | yes | A vague conceptual question about prior learnings. No tags or keywords needed. |
| `contextBlockIds` | string[] | no | IDs from `mma-context-blocks` — enables follow-up / delta recall |
| `tools` | `'none' \| 'readonly'` | no | Default `'readonly'`. `'full'` and `'no-shell'` are rejected — recall is read-only |

> Worker tier for `mma-journal-recall` is hardcoded to `complex` and is not caller-configurable. Sending `agentType` is rejected with HTTP 400.

**Why `query` is vague, not keyword-filtered:**

❌ `{ "query": "dispatch" }` — too narrow, might miss "cancellation reliability" nodes that don't mention the word "dispatch" in title.
✅ `{ "query": "what have we learned about dispatch cancellation reliability?" }` — the worker understands the concept and finds related nodes.

**Why:** the worker traverses the journal's typed graph (supersedes, refines, contradicts, depends-on) and synthesizes across related nodes. Semantic matching is the LLM's job, just like `mma-investigate`.

## Full example

```bash
RESULT=$(curl -f --show-error -s -X POST \
  -H "X-MMA-Client: $MMA_CLIENT" \
  -H "X-MMA-Main-Model: $MMA_MAIN_MODEL" \
  -H "Authorization: Bearer $TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"type":"journal_recall","query":"what have we learned about dispatch cancellation reliability?"}' \
  "http://localhost:$PORT/task?cwd=/project")
TASK_ID=$(echo "$RESULT" | jq -r '.taskId')
```

@include _shared/polling.md

@include _shared/response-shape.md

## Per-task report shape

Each task carries a `investigation` field on its per-task report (same shape as `mma-investigate`):

```json
{
  "investigation": {
    "citations": [
      { "file": "nodes/0012-dispatch-cancellation-lifecycle.md", "lines": "1-50", "claim": "Cancellation handlers must check context before writing." }
    ],
    "confidence": { "level": "high", "rationale": "Direct citations from journal nodes." },
    "diagnostics": {
      "malformedCitationLines": 0,
      "missingRequiredSections": [],
      "invalidRequiredSections": []
    }
  }
}
```

The authoritative success signals are `completed`, `message`, and `findings`. See "v5 wire shape" below for the full envelope.

## v5 wire shape (read route)

Every task result is a `ComposePayload` — seven main-agent fields plus a telemetry block.
The main-agent fields are authoritative; the telemetry block is diagnostics.

```json
{
  "completed": true,
  "message": "Recall complete; 4 relevant learnings found.",
  "findings": [
    {
      "id": "F1",
      "severity": "critical",
      "category": "correctness",
      "claim": "Cancellation handlers must check context before writing to avoid corruption.",
      "evidence": "nodes/0012-dispatch-cancellation-lifecycle.md:20-35 — verbatim substring from journal node.",
      "suggestion": null,
      "source": "implementer"
    }
  ],
  "summary": "The project learned that dispatch cancellation must synchronize context reads (node 0012) and never write without checking. Related node 0008 (refines) adds that timeout-based cancellation has race conditions under high load.",
  "filesChanged": [],
  "commitSha": null,
  "blockId": null,
  "telemetry": {
    "totalDurationMs": 1234,
    "totalCostUSD": 0.08,
    "workerSelfAssessment": "done",
    "reviewVerdict": null,
    "commitOutcome": "not_applicable",
    "stopReason": "normal",
    "haltedStage": null,
    "stages": [...]
  }
}
```

### Key fields

| Field | When populated | Notes |
|---|---|---|
| `completed` | always | `true` when at least one criterion succeeded; `false` on annotator transport failure OR unmet annotate preconditions |
| `message` | always | human-readable summary; names blocking gates or finding IDs on failure |
| `findings` | always | `source: 'implementer'` for recall; findings are the deliverable on read routes |
| `workerSelfAssessment` | always | `'done'` or `'failed'` — never `done_with_concerns` |
| `blockId` | always `null` (for write routes); string (for read routes) | recall is a read route, so `blockId` is a string — a reusable context block for delta follow-up |

### No second review

The LLM-judge stage (`annotate`) runs once, after the worker's output. Its preconditions for read-route `completed: true`:

```
gates.implement.outcome === 'advance'
&& gates.implement.payload.workerSelfAssessment === 'done'
&& (criteriaSucceeded.length > 0 || criteriaErrors.length === 0)
```

Findings are the deliverable — a recall that surfaces 5 relevant lessons is `completed: true`. Finding nothing relevant is also a valid completion (returns `findings: []`).

### `completed: false` — what it means

Only on annotator transport failure, or if the journal is inaccessible/corrupted. The `message` names the blocking gate. Re-dispatch with a broader `query` if the worker's findings were too narrow.

## Best practices

This skill is one step in a larger flow described in `multi-model-agent` → "Best practices". Recipes that involve `mma-journal-recall`:

- **Recipe A — Recall before attempting.** Call `mma-journal-recall` with your question before running `mma-delegate` / `mma-execute-plan` to avoid re-treading prior dead ends.
- **Recipe B — Recall → plan → execute.** `mma-journal-recall` → write a plan based on the learnings → `mma-execute-plan`.
- **Recipe C — Delta follow-up recall.** Feed a prior recall's `contextBlockId` into a follow-up call to dig deeper: `contextBlockIds: [priorResult.contextBlockId]`.

Anti-pattern alert: **Misusing recall as codebase search.** Recall is for the *project's learnings graph*, not the codebase. If you want to search code → `mma-investigate`. If you want to ask the journal → `mma-journal-recall`.

## Common pitfalls

❌ **Using exact tags instead of a conceptual question**
> query: "dispatch cancellation"

The worker expects a sentence with context, not keywords. **Fix:** phrase it as a question:
> query: "what have we learned about dispatch cancellation and how it interacts with timeouts?"

❌ **Asking about the codebase instead of the journal**
> query: "where is DispatchCanceller called?"

That's a codebase question. Use `mma-investigate` instead. Journal recall is for *learnings* stored in `.mmagent/journal/`, not code.

❌ **Assuming the journal exists**
> query: "what do we know about X?"

If the project hasn't used `mma-journal-record`, the journal is empty. The worker will return `not_applicable`. **Fix:** check whether the journal is active in the project first, or start recording learnings with `mma-journal-record`.

## Terminal context block

Every completed **read-route** task (audit / review / debug / investigate / recall / research) auto-registers a reusable terminal context block containing its report (headline + findings). The block id is returned on each per-task result as **`contextBlockId`**. Write routes (delegate / execute-plan / retry / journal-record) return `contextBlockId: null` — their record is the commit, not a block. This block is immutable, lives for the session duration, and counts against the project's `maxEntries` quota (default 500).

Use it for delta follow-ups — feed prior results' block ids into a later call's `contextBlockIds`, filtering out nulls:

    contextBlockIds: priorResults.map(r => r.contextBlockId).filter((id) => id !== null)

**Use cases:**
- Recall round 2: pass round 1's block into round 2's `contextBlockIds` to dig deeper on a specific thread.
- Recall → plan → execute chain: feed recall findings as a context block into `mma-execute-plan` as shared prior context.
- Multi-agent follow-up: capture a recall's block and hand it to another tool chain.

The block is registered server-side at task completion; no caller action is needed to create it. Delete it explicitly via `DELETE /context-blocks/:id` when no longer needed, or let it expire on session teardown.

## Outcome semantics

Every task result carries outcome fields that describe the recall's conclusion status:

| Field | Type | Meaning |
|---|---|---|
| `findingsOutcome` | `'found' \| 'not_applicable'` | Answers the question: did the recall produce substantive learnings? |
| `findingsOutcomeReason` | `string \| null` | When `findingsOutcome` is set, this explains why (e.g. "No relevant journal nodes found for the query" or "Journal is empty"). |
| `outcomeInferred` | `boolean` | `true` if the system inferred the outcome from findings count; `false` if the worker explicitly stated it. |
| `outcomeMalformed` | `boolean` | `true` if the outcome line was malformed and had to be repaired; `false` otherwise. |

### Enum values

- **`found`** — the recall produced one or more relevant prior learnings (findings) across one or more journal nodes.
- **`not_applicable`** — the recall could not proceed (the journal is empty, inaccessible, or nothing in it answers the query).

### Empty journal ≠ failure

A recall that searches the journal and finds nothing relevant is a valid `completed: true` outcome; it simply answers "no prior learnings match that question" — which is useful information before attempting something new.

### Per-route legal outcomes

The legal outcomes for this route are: `['found', 'not_applicable']`

- **`found`** — one or more prior learnings surfaced from the journal.
- **`not_applicable`** — the journal is empty, inaccessible, or no learnings match the query.

@include _shared/error-handling.md
