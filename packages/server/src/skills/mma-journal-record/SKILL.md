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
- You want to retrieve past entries → `mma-journal-recall` (the read route for the journal graph)
- You're mid-task and want to pause → that's what `blockedBy` is for; journal is for conclusions, not temporary blockers

## Endpoint

`POST /task?cwd=<abs-path>`

@include _shared/auth.md

## Request body

```json
{
  "type": "journal_record",
  "prompt": "Tried worker self-report for grouped-dispatch cancellation; dropped it — git diff is the source of truth. Lesson: use getRealFilesChanged. Also: Bun.spawn lacks process groups; keep node:child_process for codex subprocess management."
}
```

| Field | Type | Required | Notes |
|---|---|---|---|
| `prompt` | string | yes | A natural-language entry: what you decided, why, or what you learned. Keep it concrete (min 1 char). |

**What gets stored & where:**

Entries are integrated into a graph-structured journal store at `.mma/journal/`:
- `nodes/` — individual learning entries (keyed by unique node ID)
- `index.md` — searchable index of all entries, tags, and cross-references
- `log.md` — append-only event log of create/refine/supersede/merge operations

The worker creates, refines, or supersedes nodes in the graph (never appends blindly). You can query the index or log directly to track learning history. Writes are confined to the project's `.mma/` directory (no traversal).

## Full example

```bash
RESULT=$(curl -f --show-error -s -X POST \
  -H "X-MMA-Client: $MMA_CLIENT" \
  -H "X-MMA-Main-Model: $MMA_MAIN_MODEL" \
  -H "Authorization: Bearer $TOKEN" \
  -H "Content-Type: application/json" \
  -d '{
    "type": "journal_record",
    "prompt": "Tried worker self-report for grouped-dispatch cancellation; dropped it. Lesson: use getRealFilesChanged."
  }' \
  "http://localhost:$PORT/task?cwd=/project")
TASK_ID=$(echo "$RESULT" | jq -r '.taskId')
```

@include _shared/polling.md

@include _shared/response-shape.md

## Best practices

**One entry per decision, not per turn.**
Log once when you decide not to pursue a direction; don't log "just checked X" on every iteration.

**Keep entries concrete.**
❌ "Didn't work"  
✅ "Tried multicast-style dispatch with worker dedup; git diff is the source of truth, workers can't track cancellations atomically. Use getRealFilesChanged instead."

**Use tags to build searchable structure.**
```bash
# Later, grep your journal for all perf decisions:
grep -r "^" .mma/journal/ | grep -i "perf:"
```

## Common pitfalls

❌ **Using journal as a scratchpad**
> "Thinking about X. Maybe Y? Need to check Z."

Journal is for **conclusions**, not work-in-progress. Keep notes in a separate working file if you need to brainstorm.

❌ **Logging without context**
> "Doesn't work."

Future-you (or a teammate) won't remember what "doesn't work" means. Always include the decision frame: what did you try, why did you try it, what was the outcome, and what will you do instead?

## Context blocks

Write-route tasks (delegate / execute-plan / journal / retry) do **not** register terminal context blocks. Their artifact is the filesystem mutation (git commit for delegate; graph mutations for journal). Read-route tasks (audit / review / debug / investigate / research) auto-register blocks containing their findings.

@include _shared/error-handling.md
