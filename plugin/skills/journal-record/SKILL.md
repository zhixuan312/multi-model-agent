---
name: journal-record
description: Use when you've learned something worth remembering — a decision, design rationale, user behavior pattern, process learning, research finding, or style convention. Records it to the persistent team knowledge graph for future sessions.
when_to_use: You've completed analysis and want to log the outcome — a decision (tried X, use Y), design rationale (why the architecture works this way), user behavior (how the user prefers to work), process learning (what works in the SDLC), research finding (API feasibility, ecosystem fact), or style convention (documentation/code norms). NOT for recall/investigate/delegate; those are read routes. Journal stores team knowledge for cross-session reference.
version: "0.0.0-unreleased"
---

# mma:journal-record

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
- You're asking a question → `mma:investigate`
- You're dispatching work → `mma:delegate`
- You want to retrieve past entries → `mma:journal-recall`
- You're mid-task and want to pause → that's what `blockedBy` is for; journal is for conclusions, not temporary blockers

## Dispatch

Call the `mma_run` MCP tool with `cwd` and a `request` body (below). If the `mma_run` MCP tool
is not available in this session, run `mma clients`.

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

## Review contract (deterministic engine)

The implementer emits one structured decision per record; a **deterministic engine** applies the batch and enforces the mechanical invariants in **code** — id uniqueness, node schema, edge integrity (no dangling/self links), and submitted-record completeness (every record lands in `recorded[]` or `failed[]`). Because these guarantees are code-enforced, the LLM reviewer is redundant for them and is **skipped when the invariants pass** and the caller did not force review.

| `reviewPolicy` | Reviewer runs? |
|---|---|
| omitted (default) | Skipped when invariants pass; runs if they fail |
| `none` | Skipped when invariants pass; runs if they fail |
| `reviewed` | **Always** runs |

Pass `reviewPolicy: "reviewed"` to force a full LLM review pass (e.g. to sanity-check type classification or topic inference). The default and `"none"` both allow the skip. This is intentional — the deterministic engine replaces redundant review, it does not weaken the guarantees.

## Full example

Call `mma_run` with:

```json
{ "cwd": "/project", "request": { "type": "journal_record", "records": [ { "prompt": "Tried worker self-report for grouped-dispatch cancellation; dropped it. Lesson: use getRealFilesChanged.", "topic": "grouped-dispatch" } ] } }
```

## Response shapes

### mma_run — dispatch

Short tasks return the terminal envelope (below) inline, in the tool result. Longer-running
tasks return a handle instead:

```json
{ "taskId": "<uuid>", "type": "<route>", "cwd": "<abs path>" }
```

Use `taskId` to poll with `mma_task_get` / `mma_task_wait`.

### mma_task_get / mma_task_wait — poll

A still-running task returns identity plus progress (`status: "running"`, `phase`, `elapsedMs`,
`runningHeadline`, …) — not the shape below. A terminal task returns the full envelope — these
6 top-level fields:

```json
{
  "task": {
    "taskId": "<uuid>",
    "type": "<route>",
    "subtype": "<subtype or absent>",
    "status": "completed | done_with_concerns | failed"
  },
  "output": {
    "summary": { /* refiner JSON — shape varies by route, see below */ },
    "filesChanged": ["src/foo.ts", "src/bar.ts"],
    "contextBlockId": "<string or null>",
    "reviewerNote": null
  },
  "execution": {
    "sessions": { "implementer": "<session-id>", "reviewer": "<session-id or null>" },
    "worktree": null
  },
  "metrics": {
    "totalDurationMs": 12400,
    "totalCostUsd": 0.08,
    "implementer": { "durationMs": 8000, "costUsd": 0.05, "usage": { "inputTokens": 1200, "outputTokens": 800, "cachedReadTokens": 0, "cachedNonReadTokens": 0 } },
    "reviewer":     { "durationMs": 4000, "costUsd": 0.03, "usage": { "inputTokens": 900, "outputTokens": 400, "cachedReadTokens": 0, "cachedNonReadTokens": 0 } }
  },
  "raw": {
    "implementer": "<raw text output>",
    "reviewer": "<raw text output or null>"
  },
  "error": null
}
```

### How to read the envelope

**Step 1 — check `error`:**

| Shape | Meaning |
|---|---|
| `error` is `null` | Task succeeded — read `output` |
| `error` is `{ "code": "...", "message": "..." }` | Task failed — read `error.code` + `error.message` |

**Step 2 — extract the result from `output.summary`:**

`output.summary` is the **parsed JSON** from the refiner (reviewer). Its internal shape varies by route — see the per-skill "Reading the output" section for the exact fields. Common patterns:

| Route family | What `output.summary` contains |
|---|---|
| Read routes (audit, review, investigate, debug, research) | `{ findings: [...], criteriaCovered: [...], ... }` — findings array is the main payload |
| Write routes (delegate, execute_plan) | `{ status: 'done'\|'failed', notes }` or `{ tasks: [...], notes }` |
| Spec / Plan | `{ specPath, sections, acceptanceCriteriaCount, notes }` or `{ planPath, taskCount, tasks, notes }` |
| Journal recall | `{ answer, criteriaCovered, findings: [{ weight, category, claim, evidence, topic, fallback, nodeId, nodePath }] }` |
| Journal record | `{ recorded: [...], failed: [...] }` |

**Step 3 — for read routes, extract findings:**

```
response.output.summary.findings   ← the findings array
response.output.summary.findings[i].weight      ← "critical" | "high" | "medium" | "low"
response.output.summary.findings[i].category
response.output.summary.findings[i].claim       ← one-sentence summary
response.output.summary.findings[i].evidence    ← grounding text
response.output.summary.findings[i].suggestion  ← fix recommendation (some routes omit this)
```

**Step 4 — for write routes, read files changed:**

```
response.output.filesChanged       ← array of relative paths modified by the worker
response.output.contextBlockId     ← non-null for read routes (reusable in contextBlockIds)
```

**Step 5 — check `output.reviewerNote` (reviewer availability):**

`output.reviewerNote` is `null` on the normal path. When the reviewer ran but its output
couldn't be parsed, the task degrades to `status: "done_with_concerns"` with **`error: null`**
(a reviewer format flake is a concern, not a failure), and `output.summary` falls back to the
**implementer's** answer. `reviewerNote` then carries the reason:

```json
"reviewerNote": { "code": "reviewer_unavailable", "message": "<why the parse failed>" }
```

Treat a non-null `reviewerNote` as advisory: the answer in `output.summary` is the un-refined
implementer output, still usable. Never discard the task on `reviewerNote` alone.

### Common extraction mistakes

❌ **Reading `output.findings`** — this field does NOT exist. Findings are inside `output.summary.findings`.

❌ **Reading `results` or `structuredReport`** — these are legacy field names from older API versions. The current envelope uses `output.summary`.

❌ **Treating `output.summary` as a string** — it is parsed JSON (an object), not a string. If it looks like a string, the underlying output could not be parsed at all — check `output.reviewerNote` and, as a last resort, `raw.implementer`.

❌ **Ignoring `error: null` check** — a `status: "done_with_concerns"` task has `error: null` and is a success (advisory concerns only). Only `error !== null` is a failure. In particular, when a reviewer emits non-JSON, the task is `done_with_concerns` with `error: null`, `output.summary` holds the implementer answer, and `output.reviewerNote` explains the degrade — do NOT treat this as a failure.

### Tool call error

A malformed or unresolvable call (bad `cwd`, unknown `taskId`, failed admission) surfaces as an
MCP tool error rather than a terminal envelope — the tool result carries `isError: true` and this
payload:

```json
{ "error": { "code": "<code>", "message": "<human-readable>" } }
```

This is a different signal than Step 1 above: it means the call itself could not be admitted or
resolved, not that a dispatched task ran and failed. A dispatched task's failure always shows up
in the terminal envelope's `error` field instead.


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
