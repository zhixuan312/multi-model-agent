---
name: mma-journal-record
description: Use when you've learned something worth remembering — a decision, design rationale, user behavior pattern, process learning, research finding, or style convention. Records it to the persistent team knowledge graph for future sessions.
when_to_use: You've completed analysis and want to log the outcome — a decision (tried X, use Y), design rationale (why the architecture works this way), user behavior (how the user prefers to work), process learning (what works in the SDLC), research finding (API feasibility, ecosystem fact), or style convention (documentation/code norms). NOT for recall/investigate/delegate; those are read routes. Journal stores team knowledge for cross-session reference.
version: "0.0.0-unreleased"
---

# mma-journal-record

## Overview

Record team knowledge to the persistent journal via a fire-and-forget mma worker. The worker integrates the entry into the knowledge graph and returns immediately; you continue on your main context.

**Core principle:** The journal is the centralized team knowledge graph — decisions, design rationale, user behavior patterns, process learnings, research findings, and style conventions. Record once per insight; don't re-investigate.

## When to Use

**Use when:**
- You've made a **decision** — tried X, dropped it, use Y instead
- You've understood a **design rationale** — why the architecture/pattern is structured this way
- You've observed a **user behavior** — how the user prefers to work, communicate, or explore
- You've learned a **process** — what works in the SDLC, what phases/gates are effective
- You've discovered **knowledge** — API feasibility, ecosystem facts, research findings
- You've identified a **style convention** — documentation norms, code patterns, naming rules
- You've hit a blocking constraint worth remembering
- You want to avoid repeating a dead-end direction next session

**Don't use when:**
- You're asking a question → `mma-investigate`
- You're dispatching work → `mma-delegate`
- You want to retrieve past entries → `mma-journal-recall`
- You're mid-task and want to pause → that's what `blockedBy` is for; journal is for conclusions, not temporary blockers

## Endpoint

`POST /task?cwd=<abs-path>`

@include _shared/auth.md

## Request body

```json
{
  "type": "journal_record",
  "records": [
    {
      "prompt": "Tried worker self-report for grouped-dispatch cancellation; dropped it — git diff is the source of truth. Lesson: use getRealFilesChanged.",
      "topic": "grouped-dispatch"
    }
  ]
}
```

| Field | Type | Required | Notes |
|---|---|---|---|
| `records` | array | yes | Canonical request field. Provide 1 to 20 structured record objects in submission order; one request runs one sequential `journal_record` pipeline — the agent processes the records one-by-one and returns a per-record `recorded[]` / `failed[]` result. |
| `records[].prompt` | string | yes | A natural-language entry: what you decided, why, or what you learned. Keep it concrete (min 1 char). |
| `records[].topic` | string | no | Optional caller-supplied primary subject. Must already be lowercase-kebab. When provided, the worker uses it verbatim. When omitted, the system infers one topic per record from the learning content and existing journal topics. |

**Legacy compatibility (still accepted).** A legacy single-record body of `{ "type": "journal_record", "prompt": "...", "topic": "..." }` is normalized to a one-element `records` array at the request boundary, so existing callers keep working unchanged. Do not mix the two shapes — a body carrying both `records` and a top-level `prompt`/`topic` is rejected with `400 invalid_request`.

**What gets stored & where:**

Entries are integrated into a graph-structured journal store at `.mma/journal/`:
- `nodes/` — individual learning entries (keyed by unique node ID)
- `index.md` — searchable index of all entries, topics, tags, and cross-references
- `log.md` — append-only event log of create/refine/supersede/merge operations

The worker creates, refines, or supersedes nodes in the graph (never appends blindly). The derived `index.md` catalog uses the column order `id | timestamp | type | status | title | topic | tags`. Legacy rows may be regenerated with `topic: unscoped` without rewriting historical node files.

## Full example

```bash
RESULT=$(curl -f --show-error -s -X POST \
  -H "X-MMA-Client: $MMA_CLIENT" \
  -H "X-MMA-Main-Model: $MMA_MAIN_MODEL" \
  -H "Authorization: Bearer $TOKEN" \
  -H "Content-Type: application/json" \
  -d '{
    "type": "journal_record",
    "prompt": "Tried worker self-report for grouped-dispatch cancellation; dropped it. Lesson: use getRealFilesChanged.",
    "topic": "grouped-dispatch"
  }' \
  "http://localhost:$PORT/task?cwd=/project")
TASK_ID=$(echo "$RESULT" | jq -r '.taskId')
```

@include _shared/polling.md

@include _shared/response-shape.md

## Best practices

**One entry per decision, not per turn.**
Log once when you decide not to pursue a direction; don't log "just checked X" on every iteration.

**Use `topic` when you already know the primary subject.**
Provide a caller-supplied `topic` for stable subsystem names so the worker does not have to infer one. When you omit `topic`, the worker infers one from the learning content and exact-slug matches against existing journal topics.

**Keep entries concrete.**
❌ "Didn't work"  
✅ "Tried multicast-style dispatch with worker dedup; git diff is the source of truth, workers can't track cancellations atomically. Use getRealFilesChanged instead."

## Common pitfalls

❌ **Using journal as a scratchpad**
> "Thinking about X. Maybe Y? Need to check Z."

Journal is for **conclusions**, not work-in-progress. Keep notes in a separate working file if you need to brainstorm.

❌ **Logging without context**
> "Doesn't work."

Future-you (or a teammate) won't remember what "doesn't work" means. Always include the decision frame: what did you try, why did you try it, what was the outcome, and what will you do instead?

❌ **Sending a non-normalized topic**
> `"topic": "Worker Runtime"`

The request schema accepts only lowercase-kebab topics. Fix it before dispatch: `"topic": "worker-runtime"`.

## Context blocks

Write-route tasks (delegate / execute-plan / journal) do **not** register terminal context blocks. Their artifact is the filesystem mutation (git commit for delegate; graph mutations for journal). Read-route tasks (audit / review / debug / investigate / research) auto-register blocks containing their findings.

## Multi-repo mode (parent-aware)

In a parent-aware multi-repo flow, records go to the **parent** workspace **journal** (one product-level
store, reached with `cwd = parent workspace`). Pass `topic = <repo-slug>` (normalized **lowercase-kebab**,
e.g. `multi-model-agent`) to scope a learning to the repo it came from. Single-project mode is unchanged.

@include _shared/error-handling.md
