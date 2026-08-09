---
name: mma-execute-plan
description: Use when a plan or spec file exists on disk (any markdown with task headings — .mma/plans/*.md, a TODO list, a spec doc) and you need to implement one or more tasks from it sequentially in one worker session
when_to_use: A plan file exists on disk AND you need to implement one or more tasks from it AND mma is running. Prefer this over inline Agent dispatches — workers are cheaper and don't pollute main context. Task selectors are plan task IDs (e.g. `I-1`); the full heading works too.
version: "0.0.0-unreleased"
---

# mma-execute-plan

## Overview

Dispatch Contract Tasks from a **contract-first** plan file to a single worker session. The `tasks` array selects which Contract Task headings to execute — the worker receives them all in one prompt and executes them sequentially in plan order in your checkout, on the branch you already have checked out. Empty `tasks` = run all.

**Core principle:** The plan IS the prompt. The worker is an **autonomous** implementer of each task's contract — it implements freely and makes the plan-authored acceptance tests pass, rather than copying implementation code.

## Contract-first execution (what the worker does)

- The plan must be a contract-first, deliverable-neutral Contract Task plan. A legacy/non-conforming plan is rejected before any worker starts, with a terminal `status: "failed"`.
- A task's deterministic check is OPTIONAL — a task with no check is not an error, and its Contract alone defines what "done" means. The pipeline validates and materializes any task's plan-authored checks, then **re-materializes them from the plan before scoring** — so an executor cannot weaken them.
- **Completion is REPORTED, not gated.** `completionPercent` is derived from the reviewer's
  per-task verdicts (`round(done / dispatched * 100)`), and a shortfall names the outstanding task
  ids. A task reported not-done, an unresolvable reviewer report, or failing acceptance tests all
  terminate `done_with_concerns` with the work **committed on your branch** — never `failed`.
  A plan is written before anyone knows what they don't know, so divergence from it is expected
  and the plan may be what needs correcting. PR review is the gate.
- `failed` means the route could not RUN or could not DELIVER: plan unreadable/malformed,
  acceptance-test materialization failure, a dead implementer turn, cancellation, or a failed
  commit. If you see `failed`, something broke — otherwise read the concerns and review the diff.
- Pre-dispatch/materialization failures surface as specific terminal error codes: `unsupported-legacy-plan`, `malformed-plan`, `unsafe-test-path`, and `test-path-collision`.

## When to Use

**Use when:**
- A plan/spec markdown exists with numbered task headings
- You want to dispatch a subset (or all) of those tasks
- Tasks are sequential (later tasks build on earlier ones) — the worker handles ordering

**Don't use when:**
- No plan file → `mma-delegate` (pass the prompt directly)
- The "plan" is in conversation only, not on disk → write it to disk first, or use `mma-delegate`

## Dispatch

Call the `mma_run` MCP tool with `cwd` and a `request` body (below). If the `mma_run` MCP tool
is not available in this session, run `mma clients`.

## Request body

```json
{
  "type": "execute_plan",
  "prompt": "Focus on the backend tasks only",
  "tasks": [
    "1. Add input validation to login handler",
    "2. Write unit tests for the auth module"
  ],
  "target": {
    "paths": ["/project/.mma/plans/2026-07-11-feature.md"]
  },
  "contextBlockIds": []
}
```

| Field | Type | Required | Notes |
|---|---|---|---|
| `prompt` | string | no | Optional caller context for the worker (e.g. "focus on backend tasks", "skip tests") — injected alongside the plan content |
| `tasks` | string[] | no | Task selectors matching plan headings. Empty or omitted = run all tasks in the plan |
| `target.paths` | string[] | yes | EXACTLY one entry: the plan markdown file |
| `contextBlockIds` | string[] | no | IDs from `mma-context-blocks` (max 2) — the right place for source files referenced by the plan |
| `practice` | `"software"` | no | Selects the retained CODE technique for this dispatch (caller tracing, error paths, security sinks, schema conformance, test adequacy). Set it when code-level technique is required — not merely when the artifact is code: an n8n workflow or Terraform module often needs it, a report or specification does not. Omitted = the deliverable-neutral implementer. The engine NEVER infers it. Inside `/mma-flow`, read the one persisted `routing.practice` value so every stage of a flow routes identically. |

@include _shared/review-policy.md

> Worker tier defaults to `standard`. Send `agentTier` to override if needed.

## Full example

Call `mma_run` with:

```json
{ "cwd": "/project", "request": { "type": "execute_plan", "tasks": ["3. Migrate database schema"], "target": { "paths": ["/project/.mma/plans/2026-07-11-feature.md"] } } }
```

## Response shapes

`mma_run` returns either the terminal envelope inline (short tasks) or a `{ taskId, type, cwd }`
handle for longer ones — poll with `mma_task_get`, block with `mma_task_wait`, cancel with
`mma_task_cancel`. See `_shared/response-shape.md` below for the full envelope shape and the tool
call error shape.

@include _shared/response-shape.md

## Natural next step

Tasks are implemented. Usual next moves (soft suggestions — none forced):
- **Review the changes** → `mma-review` on the changed files.
- **Re-run only the failures** → a fresh `mma-execute-plan` scoped to ONLY the failed task IDs (pass just those in `tasks[]`), never a full re-dispatch that re-charges the successful tasks.

## Best practices

This skill is one step in the larger flow described in `multi-model-agent` → "Best practices". Recipes that involve `mma-execute-plan`:

- **Recipe C — Investigate-plan-execute.** `mma-investigate` → write the plan → `mma-execute-plan`. Register the plan file as a context block before the execute-plan call so it isn't re-inlined into every worker's prompt.

Anti-pattern alert: **`full-batch-redispatch`** (AP4). When the dispatch returns mixed `done` / `failed`, do NOT re-run the whole task list — dispatch a fresh `mma-execute-plan` scoped to ONLY the failed task IDs (`tasks[]`). Re-running the whole list re-charges every successful task.

## Common pitfalls

❌ **Task selector carries no task ID**
> tasks: ["Migrate db schema"]    ← no `I-N` anywhere in the string

Every Contract Task heading is `### Task <ID>: <title>` (e.g. `### Task I-3: Migrate database schema`), and selection resolves on that **ID** — the same key the reviewer contract uses. **Fix:** pass the ID (`tasks: ["I-3"]`). Any spelling that CONTAINS the ID also works — `"Task I-3"`, or the whole heading with or without its `(← AC-…)` annotation — so copy-pasting a heading is safe. Only a selector with no ID at all is rejected, and the error lists every available ID.

❌ **Forgetting the plan file in `target.paths`**
> target.paths: ["/project/src/db/schema.sql"]    ← no plan file

Worker can't read the task body. **Fix:** always include the plan path: `target.paths: ["/project/.mma/plans/2026-07-11-feature.md"]`.

execute_plan handles dependencies naturally since tasks run sequentially in one session — the worker executes them in order in your checkout, and the engine makes one commit at the end.

## Terminal context block

Write-route tasks (delegate / execute-plan) do NOT register a terminal context block — their durable record is the commit the engine makes on your branch, plus `output.filesChanged` (which is `git diff --name-only` across that commit, not a worker self-report). The result's `contextBlockId` is always `null` for these routes. Read routes (audit / review / debug / investigate / research) return a non-null `contextBlockId`; see those skills for the delta-follow-up recipe.


## Non-git targets

Execution is **one plan file** per request. execute_plan always runs **in-place**: it edits the `cwd`
you submit, on whatever branch that checkout already has. **You own the branch** — cut and check out
your task branch BEFORE dispatching; the engine never creates a branch or a worktree, it commits your
work on yours. A **non-git** target is edited in-place too, just with no commit. No new execution task type
is introduced, and git is never forced.

## Relationship to a disposition-driven flow (mma-flow B5)

execute_plan itself is disposition-agnostic — it does not read or branch on `disposition`. When
dispatched as B5 inside `mma-flow`'s caller-owned flow (see `mma-flow/SKILL.md` → Stage 0 —
LOCATE), its edits ARE the deliverable the flow's later stages check: B6 (`mma-review`) reviews
them, and B7 runs the approved contract's declared `command` acceptance criteria against them.
Whether that output ends up committed on a PR branch (`pr`), committed directly on the current
branch (`commit-in-place`), or written to a declared artifact path (`deliver-file`) is entirely
the caller's concern — execute_plan just implements the plan's tasks in the checkout it is given.
