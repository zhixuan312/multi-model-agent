---
name: mma-journal-record
description: Use when you've abandoned an approach, hit a constraint, or concluded something worth remembering — record it to the persistent journal as a fire-and-forget decision audit trail for future sessions.
when_to_use: You've completed analysis and want to log the outcome — abandoned an approach, hit a blocking constraint, or reached a conclusion worth remembering. NOT for recall/investigate/delegate; those are read routes. Journal stores conclusions for cross-session reference.
version: "0.0.0-unreleased"
---

# mma-journal-record

## Overview

Record a learning, constraint, or decision outcome to the persistent journal via a fire-and-forget mmagent worker. The worker stores the entry and returns immediately; you continue on your main context.

**Core principle:** Journal is an audit trail of what you've decided, discovered, or abandoned. Record it once per session; don't re-investigate.

## When to Use

**Use when:**
- You've abandoned an approach and want to log why
- You've hit a blocking constraint worth remembering
- You've reached a conclusion (e.g., "Pattern X doesn't work in this codebase")
- You've decided not to pursue a direction and want to avoid repeating that decision next session

**Don't use when:**
- You're asking a question → `mma-investigate`
- You're dispatching work → `mma-delegate`
- You want to retrieve past entries → journal is append-only, not searchable; use `git log` or `.mmagent/journal/` files directly
- You're mid-task and want to pause → that's what `blockedBy` is for; journal is for conclusions, not temporary blockers

## Endpoint

`POST /task?cwd=<abs-path>`

@include _shared/auth.md

## Request body

```json
{
  "type": "journal_record",
  "entry": "Tried worker self-report for grouped-dispatch cancellation; dropped it — git diff is the source of truth. Lesson: use getRealFilesChanged. Also: Bun.spawn lacks process groups; keep node:child_process for codex subprocess management."
}
```

**Batch your learnings into ONE call.** Collect every learning from the session and send them together in `learnings[]` — do NOT fire multiple concurrent `journal-record` calls. One worker integrates them sequentially in a single pass (fast and collision-free).

| Field | Type | Required | Notes |
|---|---|---|---|
| `learnings` | string[] | yes | 1–20 entries, each 20–8000 chars. Each is a natural-language entry: what you decided, why, or what you learned. Keep them concrete. |
| `tagHints` | string[] | no | Optional tags applied across ALL learnings (batch-scoped); the worker revises/normalizes per node. Advisory. |

**What gets stored & where:**

Entries are integrated into a graph-structured journal store at `.mmagent/journal/`:
- `nodes/` — individual learning entries (keyed by unique node ID)
- `index.md` — searchable index of all entries, tags, and cross-references
- `log.md` — append-only event log of create/refine/supersede/merge operations

The worker creates, refines, or supersedes nodes in the graph (never appends blindly). You can query the index or log directly to track learning history. Writes are confined to the project's `.mmagent/` directory (no traversal).

## Full example

```bash
RESULT=$(curl -f --show-error -s -X POST \
  -H "X-MMA-Client: $MMA_CLIENT" \
  -H "X-MMA-Main-Model: $MMA_MAIN_MODEL" \
  -H "Authorization: Bearer $TOKEN" \
  -H "Content-Type: application/json" \
  -d '{
    "type": "journal_record",
    "entry": "Tried worker self-report for grouped-dispatch cancellation; dropped it. Lesson: use getRealFilesChanged."
  }' \
  "http://localhost:$PORT/task?cwd=/project")
TASK_ID=$(echo "$RESULT" | jq -r '.taskId')
```

@include _shared/polling.md

@include _shared/response-shape.md

## Per-task report shape

Each task carries a structured report containing the graph operation metadata:

```json
{
  "summary": "recorded 2, failed 0; created 0012, superseded 0009",
  "filesChanged": [".mmagent/journal/nodes/0012.md", ".mmagent/journal/index.md", ".mmagent/journal/log.md"],
  "recorded": [
    { "learningIndex": 0, "op": "create", "ids": ["0012"] },
    { "learningIndex": 1, "op": "supersede", "ids": ["0013"] }
  ],
  "failed": []
}
```

`recorded` and `failed` partition the input learnings by `learningIndex`. To retry, re-send the `failed[]` entries' `learning` text as a new `learnings[]` batch (reuse the original `tagHints`/`contextBlockIds`).

The authoritative success signal is `completed` + the presence of `filesChanged`. See "v5 wire shape" below for the full envelope.

## v5 wire shape (reviewed write route)

Every task result is a `ComposePayload` — seven main-agent fields plus a telemetry block.
The main-agent fields are authoritative; the telemetry block is diagnostics.

```json
{
  "completed": true,
  "message": "Journal entry created (node 0012); superseded prior learning (node 0009)",
  "findings": [],
  "summary": "created 0012; superseded 0009",
  "filesChanged": [".mmagent/journal/nodes/0012.md", ".mmagent/journal/index.md", ".mmagent/journal/log.md"],
  "commitSha": null,
  "blockId": null,
  "telemetry": {
    "totalDurationMs": 5400,
    "totalCostUSD": 0.04,
    "workerSelfAssessment": "done",
    "reviewVerdict": "approved",
    "commitOutcome": "not_applicable",
    "stopReason": "normal",
    "haltedStage": null,
    "stages": [
      { "name": "prepare",        "outcome": "advance", "durationMs": 2,    "costUSD": 0 },
      { "name": "register-block", "outcome": "skip",    "comment": "register-block does not apply to route=journal", "durationMs": 0, "costUSD": 0 },
      { "name": "implement",      "outcome": "advance", "durationMs": 3200, "costUSD": 0.02 },
      { "name": "review",         "outcome": "advance", "durationMs": 1800, "costUSD": 0.01 },
      { "name": "rework",         "outcome": "skip",    "comment": "rework skipped because review approved", "durationMs": 0, "costUSD": 0 },
      { "name": "commit",         "outcome": "skip",    "comment": "commit does not apply to non-git routes", "durationMs": 0, "costUSD": 0 },
      { "name": "annotate",       "outcome": "advance", "durationMs": 340,  "costUSD": 0.01 },
      { "name": "compose",        "outcome": "advance", "durationMs": 56,   "costUSD": 0 },
      { "name": "terminal",       "outcome": "advance", "durationMs": 2,    "costUSD": 0 }
    ]
  }
}
```

### Key fields

| Field | When populated | Notes |
|---|---|---|
| `completed` | always | `true` when entry is created/refined/superseded and approved; `false` on review rejection, path traversal, or write failure |
| `message` | always | human-readable summary (e.g., "created 0012; superseded 0009"); read on failure for diagnostic |
| `findings` | always | issues surfaced by the reviewer (e.g., unclear learning, duplicate with 0009). Empty if approved as-is. |
| `filesChanged` | always | graph journal paths modified: `nodes/`, `index.md`, `log.md` (relative to `cwd`) |
| `workerSelfAssessment` | always | `'done'` or `'failed'` — worker's assessment of completeness |
| `blockId` | always `null` | journal is a task route, not register-context-block |
| `commitSha` | always `null` | journal entries are graph mutations, not git commits |
| `reviewVerdict` | via telemetry | `'approved'` \| `'rejected_with_rework'` \| `'rejected'` — reviewer's verdict on the learned entry |

### Reviewed write lifecycle

Unlike read routes (audit/investigate/debug), journal runs a full review cycle: **implement** → **review** → [optional **rework**] → **commit** (skipped for non-git routes) → **annotate**. If the reviewer finds issues (e.g., the learning is ambiguous, the node supersedes multiple prior entries), a rework round applies targeted edits before finalization.

### `completed: false` — what it means

Path traversal detected, write permission denied, or directory creation failed. The `message` names the blocking issue.

## Best practices

**One entry per decision, not per turn.**
Log once when you decide not to pursue a direction; don't log "just checked X" on every iteration.

**Keep entries concrete.**
❌ "Didn't work"  
✅ "Tried multicast-style dispatch with worker dedup; git diff is the source of truth, workers can't track cancellations atomically. Use getRealFilesChanged instead."

**Use tags to build searchable structure.**
```bash
# Later, grep your journal for all perf decisions:
grep -r "^" .mmagent/journal/ | grep -i "perf:"
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
