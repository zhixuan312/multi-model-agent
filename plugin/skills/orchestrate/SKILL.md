---
name: orchestrate
description: Use when a frontend workflow needs a high-quality LLM brain for orchestration — send a structured prompt, get a structured response, reuse the session across workflow phases
when_to_use: A multi-phase workflow (explore → spec → plan → execute) needs an intelligent orchestrator that maintains session context across phases. Each call sends a self-contained prompt; the agent processes it and returns structured output the calling system parses directly.
version: "0.0.0-unreleased"
---

# mma:orchestrate

## Overview

The orchestrate endpoint provides a session-persistent, high-quality LLM agent for multi-phase workflow orchestration. Unlike worker routes (audit, delegate, review), the orchestrate agent has no reviewer, no commit, and no findings structure — it takes a prompt and returns the output the caller needs.

**Core principle:** The frontend owns the workflow state; MMA provides the LLM continuity. Each prompt is self-contained; session reuse provides project context across phases.

## When to Use

**Use when:**
- A multi-step workflow needs an intelligent brain across phases
- The calling system constructs structured prompts and expects structured responses
- Session continuity across workflow phases improves output quality
- The task requires synthesis, analysis, or decision-making — not file writing

**Don't use when:**
- You need file modifications → use `mma:delegate`
- You need structured code review → use `mma:review`
- You need document auditing → use `mma:audit`
- A single API call suffices — orchestrate is for when you need tool use + reasoning

## Dispatch

Call the `mma_run` MCP tool with `cwd` and this `request` body. If the `mma_run` MCP tool is not
available in this session, run `mma clients`.

```json
{
  "cwd": "/project",
  "request": {
    "type": "orchestrate",
    "prompt": "Synthesize the exploration results into a requirements specification...",
    "outputFormat": "json"
  }
}
```

| Field | Type | Required | Notes |
|---|---|---|---|
| `type` | `"orchestrate"` | yes | Discriminator |
| `prompt` | string | yes | The full instruction for this workflow phase |
| `outputFormat` | string | no | Hint for desired output format (e.g. `"json"`, `"markdown"`) |
| `sessionIds` | object | no | `{ implementer: "<session-id>" }` — reuse a prior session |
| `contextBlockIds` | string[] | no | IDs from `mma:context-blocks` (max 2) |

> Worker tier defaults to `main` — the model driving mma. `agents.main` is required in the config and the daemon refuses to start without it, so there is no substitution to another tier. Send `agentTier` to run on `standard` or `complex` instead. Review is always skipped — there is no reviewer phase.

## Session Reuse

To maintain context across workflow phases, capture the session ID from the first response and pass it back:

```json
// Phase 1: Exploration
{ "cwd": "/project", "request": { "type": "orchestrate", "prompt": "Explore the codebase for auth patterns..." } }
// -> read execution.sessions.implementer from the terminal envelope as sessionId

// Phase 2: Specification (reuse session)
{ "cwd": "/project", "request": { "type": "orchestrate", "prompt": "Based on your exploration, write a spec...", "sessionIds": { "implementer": "<sessionId from phase 1>" } } }
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

