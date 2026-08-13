---
name: plan
description: Use when you have a spec file on disk and need a contract-first implementation plan written by a worker — produces ordered Contract Tasks (inputs/outputs/mapping/errors/invariants) with plan-authored acceptance tests and no implementation code, plus exact file paths
when_to_use: You have a formal specification on disk (written by mma:spec or manually) AND you want a contract-first implementation plan produced by a worker. If you don't have a spec yet → use mma:brainstorm to create one. If you have a plan and want to execute it → use mma:execute-plan. If you want to audit an existing plan → use mma:audit subtype:plan.
version: "0.0.0-unreleased"
---

# mma:plan

## Overview

Dispatch a spec file to a complex worker that writes a **contract-first** implementation plan. The worker reads the spec, explores the target material (a codebase, or a non-code deliverable such as a report format or workflow configuration), verifies ground truth at HEAD, then produces ordered **Contract Tasks** — each declares its output and dependencies and states a contract (inputs, outputs, data mapping, errors, invariants), plus a **plan-authored deterministic check** when the task's technical acceptance criterion admits one. No task contains implementation code or final deliverable content. The reviewer verifies every path and symbol against the real target material.

**Core principle:** The spec defines WHAT to build. The plan defines the *contract* for each unit of work — and, where a pass/fail check is possible, the executable check that pins it — then a capable executor implements freely against that contract. The plan does not dictate implementation code or deliverable content; a declared check is the contract's teeth, and not every task can have one.

## When to Use

**Use when:**
- A spec file exists on disk (written by `mma:spec`, `mma:brainstorm`, or manually)
- You want a contract-first plan of Contract Tasks, each with a deterministic check when one applies
- The plan will be executed via `mma:execute-plan`

**Don't use when:**
- No spec exists yet → `mma:brainstorm` (full design workflow) or `mma:spec` (write spec from decisions)
- You want to audit an existing plan → `mma:audit subtype:plan`
- You want to execute a plan → `mma:execute-plan`
- The task is simple enough for `mma:delegate` (no plan needed)

## Dispatch

Call the `mma_run` MCP tool with `cwd` and a `request` body (below). If the `mma_run` MCP tool
is not available in this session, run `mma clients`.

## Request body

```json
{
  "type": "plan",
  "prompt": "Write a TDD implementation plan for the database-free claims demo",
  "target": { "paths": ["/project/.mma/specs/2026-07-06-claims-demo.md"] }
}
```

| Field | Type | Required | Notes |
|---|---|---|---|
| `type` | `"plan"` | yes | Literal route discriminator — must be exactly `"plan"` |
| `prompt` | string | yes | Goal description + any constraints beyond the spec |
| `target` | object | yes | Container — must have exactly one of `paths` or `inline`, not both |
| `target.paths` | string[] | primary | Path to the spec file (exactly one file) |
| `target.inline` | string | alternative | Spec content pasted directly. When using inline, `outputPath` is **required** |
| `outputPath` | string | conditional | Where to write the plan (relative to cwd, must not contain `..` or be absolute). Required when `target.inline` is used. When omitted with `target.paths`, the default **inherits the spec's dated stem** → `.mma/plans/<spec-stem>.md` (the first `YYYY-MM-DD-`-prefixed input; no double-date), so the plan shares the exploration/spec stem. An undated source falls back to `.mma/plans/<today>-<basename>.md`. |
| `reviewPolicy` | `"reviewed"` \| `"none"` | no | Whether the plan gets a reviewer pass. Default `"reviewed"` |
| `practice` | `"software"` | no | Selects the retained CODE technique for this dispatch (caller tracing, error paths, security sinks, schema conformance, test adequacy). Set it when code-level technique is required — not merely when the artifact is code: an n8n workflow or Terraform module often needs it, a report or specification does not. Omitted = the deliverable-neutral implementer. The engine NEVER infers it. Inside `/mma:flow`, read the one persisted `routing.practice` value so every stage of a flow routes identically. |
| `contextBlockIds` | string[] | no | IDs from `mma:context-blocks` (max 2) for additional context |

Inline mode — `outputPath` is required because no basename can be derived:

```json
{
  "type": "plan",
  "prompt": "Write a TDD implementation plan for the database-free claims demo",
  "target": { "inline": "# Claims Demo Spec\n\n## Requirements\n..." },
  "outputPath": ".mma/plans/2026-07-06-claims-demo.md"
}
```

> Worker tier defaults to `complex`. Send `agentTier` to override if needed.

### Output path rules

| Input mode | `outputPath` provided? | Behavior |
|---|---|---|
| `target.paths` | No | Auto-derived: `.mma/plans/YYYY-MM-DD-<spec-basename>.md` |
| `target.paths` | Yes | Uses provided path |
| `target.inline` | No | HTTP 400 `invalid_request` — cannot derive basename from inline |
| `target.inline` | Yes | Uses provided path |

### `reviewPolicy` — review lifecycle per task

All task types default to `"reviewed"` (two-phase pipeline: implementer + refiner).
Only `orchestrate` forces `"none"`. Callers can override per-request.

For read-only routes (audit, review, debug, investigate, research, journal_recall),
the refiner verifies the implementer's output against source material — checking
citations, evidence accuracy, and completeness. For write routes (delegate,
execute_plan), the refiner also fixes issues directly in the working tree.

| Value | Behavior | Use when |
|---|---|---|
| `"reviewed"` | Two-phase pipeline: implement + review (default) | Default for all types |
| `"none"` | Skip the review stage | Trivially mechanical edits or throwaway scripts where a second-pass reviewer adds nothing |


## Full example

Call `mma_run` with:

```json
{ "cwd": "/project", "request": { "type": "plan", "prompt": "Write a TDD implementation plan for the database-free claims demo spec", "target": { "paths": ["/project/.mma/specs/2026-07-06-claims-demo.md"] } } }
```

## Response shapes

### mma_run — dispatch

Short tasks return the terminal envelope (below) inline, in the tool result. Longer-running
tasks return a handle instead:

```json
{ "executionId": "<uuid>", "type": "<route>", "cwd": "<abs path>" }
```

Use `executionId` to poll with `mma_execution_get` / `mma_execution_wait`.

### mma_execution_get / mma_execution_wait — poll

A still-running execution returns identity plus progress (`status: "running"`, `phase`,
`elapsedMs`, `runningHeadline`, …) — not the shape below. A terminal execution returns the
full envelope — these 5 top-level fields:

```json
{
  "execution": {
    "executionId": "<uuid>",
    "type": "<route>",
    "subtype": "<subtype or absent>",
    "practice": "<practice or absent>",
    "status": "completed | done_with_concerns | failed | cancelled",
    "sessions": { "implementer": "<session-id>", "reviewer": "<session-id or null>" },
    "worktree": null,
    "dirtyAtDispatch": false
  },
  "output": {
    "summary": { /* refiner JSON — shape varies by route, see below */ },
    "filesChanged": ["src/foo.ts", "src/bar.ts"],
    "contextBlockId": "<string or null>",
    "reviewerNote": null
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

`execution` is the ONE merged top-level section — there is no separate `task` section. It
carries the execution's own identity (`executionId`, `type`, `status`) alongside what used to
live in a distinct `execution` block (`sessions`, `worktree`, `dirtyAtDispatch`). `subtype`
(audit's criteria set) and `practice` (the retained software technique for
plan/execute_plan/review/debug) are mutually exclusive and both optional — read them
defensively.

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

A malformed or unresolvable call (bad `cwd`, unknown `executionId`, failed admission) surfaces as an
MCP tool error rather than a terminal envelope — the tool result carries `isError: true` and this
payload:

```json
{ "error": { "code": "<code>", "message": "<human-readable>" } }
```

This is a different signal than Step 1 above: it means the call itself could not be admitted or
resolved, not that a dispatched task ran and failed. A dispatched task's failure always shows up
in the terminal envelope's `error` field instead.


## Reading the result

The terminal envelope's `output.summary` contains:

```json
{
  "planPath": ".mma/plans/2026-07-06-claims-demo.md",
  "taskCount": 17,
  "tasks": [
    { "title": "Task I-1: resolveDataSource", "verdict": "executable" },
    { "title": "Task I-2: Repository types", "verdict": "executable" },
    { "title": "Task I-3: Validate paging", "verdict": "partial" }
  ],
  "notes": "spec assumed src/utils/ but actual path is src/lib/; reconciled in all tasks"
}
```

| Field | Type | Required | Notes |
|---|---|---|---|
| `planPath` | string | yes | Path to the written plan file |
| `taskCount` | number | yes | Number of tasks in the plan |
| `tasks` | array of `{ title, verdict }` | yes | Per-task title + verdict (see below) |
| `notes` | string | no | Reconciliations or caveats the worker surfaced |

### Per-task verdicts

| Verdict | Meaning | Action |
|---|---|---|
| `executable` | Zero critical/high findings. Safe to dispatch to `mma:execute-plan` | Dispatch directly |
| `partial` | High findings, no critical. May execute but results are ambiguous | Review before dispatching |
| `blocked` | Critical findings. Would silently fail or mis-edit the deliverable | Fix the plan before dispatching |

### Plan structure (what the worker produces)

The plan file follows this structure:
- **Phases:** sequential build stages (`## Phase N — <name>: <what works at the end>`), each a
  working increment a human could verify, holding a sensible handful of tasks (roughly 2–6).
- **Contract Tasks:** each task (`### Task I-N: <title>`) declares its output and dependencies,
  carries a contract (inputs, outputs, data mapping, errors, behavior/invariants), and states a
  technical acceptance criterion traced to a business AC. When that criterion admits a deterministic
  pass/fail check, the task also carries a complete **plan-authored check** — but never implementation
  code or the deliverable's own content. The task's contract is deliverable-neutral: it applies the
  same way whether the task builds code, produces a document, or configures a workflow.
- **Full-suite gate:** the commands/checks that must pass at every task boundary.

## Natural next step

The plan is written. Usual next moves (soft suggestions — none forced):
- **Audit it against the target material** → `mma:audit` (subtype: plan) — verify task ordering, signatures, and file paths before execution.
- **Execute it** → `mma:execute-plan` — implement the tasks on a worker.

## Best practices

- **One spec per plan.** Pass exactly one spec file. Multi-spec plans produce unfocused output.
- **Audit the plan after.** Run `mma:audit subtype:plan` on the produced plan for additional verification beyond the built-in reviewer.
- **Execute via `mma:execute-plan`.** The plan structure is designed for `mma:execute-plan` task matching — task headings map directly.

## Common pitfalls

❌ **Passing a brain dump instead of a spec.** The worker needs structured requirements to produce a correct plan. An unstructured prompt produces a vague plan. **Fix:** write a formal spec first via `mma:spec` or `mma:brainstorm`, then pass the spec file.

❌ **Using `target.inline` without `outputPath`.** The worker cannot derive a filename from inline content — provide `outputPath` explicitly.

❌ **Skipping `mma:audit subtype:plan` after.** The built-in reviewer checks 12 perspectives, but a standalone plan audit provides a second independent verification pass. **Fix:** dispatch `mma:audit subtype:plan` on the produced plan file before executing.

## Multi-repo mode (parent-aware)

In multi-repo mode, `/mma:flow` fans out **one** `mma:plan` dispatch per involved repo. Each dispatch plans
**exactly one repo**'s slice of the **shared spec** (two repo dispatches differ only in repo scope and
`outputPath`), and writes `.mma/plans/<stem>--<repo-slug>.md` under the parent workspace. Planning **one
repo** at a time keeps each plan a clean single-file `execute_plan` input. Single-project mode writes the
usual `<stem>.md`.
