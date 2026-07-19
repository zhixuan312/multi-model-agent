---
name: mma-plan
description: Use when you have a spec file on disk and need a TDD implementation plan written by a worker — produces ordered tasks with complete code blocks, exact file paths, and verification commands
when_to_use: You have a formal specification on disk (written by mma-spec or manually) AND you want a TDD implementation plan produced by a worker. If you don't have a spec yet → use mma-brainstorm to create one. If you have a plan and want to execute it → use mma-execute-plan. If you want to audit an existing plan → use mma-audit subtype:plan.
version: "0.0.0-unreleased"
---

# mma-plan

## Overview

Dispatch a spec file to a complex worker that writes a TDD implementation plan. The worker reads the spec, explores the codebase, verifies ground truth at HEAD, then produces ordered tasks with complete code blocks, exact file paths, and verification commands. The reviewer verifies every path and symbol against the real codebase.

**Core principle:** The spec defines WHAT to build. The plan defines HOW — in what order, with what files, with what tests, with what code. The worker reads the codebase deeply to produce a plan that a standard-tier executor can follow mechanically.

## When to Use

**Use when:**
- A spec file exists on disk (written by `mma-spec`, `mma-brainstorm`, or manually)
- You want a TDD implementation plan with complete code blocks
- The plan will be executed via `mma-execute-plan`

**Don't use when:**
- No spec exists yet → `mma-brainstorm` (full design workflow) or `mma-spec` (write spec from decisions)
- You want to audit an existing plan → `mma-audit subtype:plan`
- You want to execute a plan → `mma-execute-plan`
- The task is simple enough for `mma-delegate` (no plan needed)

## Endpoint

`POST /task?cwd=<abs-path>`

@include _shared/auth.md

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
| `contextBlockIds` | string[] | no | IDs from `mma-context-blocks` (max 2) for additional context |

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

@include _shared/review-policy.md

## Full example

```bash
RESULT=$(curl -f -sS -X POST \
  -H "Authorization: Bearer $TOKEN" \
  -H "X-MMA-Client: $MMA_CLIENT" \
  -H "X-MMA-Main-Model: $MMA_MAIN_MODEL" \
  -H "Content-Type: application/json" \
  -d '{
    "type": "plan",
    "prompt": "Write a TDD implementation plan for the database-free claims demo spec",
    "target": { "paths": ["/project/.mma/specs/2026-07-06-claims-demo.md"] }
  }' \
  "http://localhost:$PORT/task?cwd=/project")
TASK_ID=$(echo "$RESULT" | jq -r '.taskId')
```

@include _shared/polling.md

@include _shared/response-shape.md

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
| `executable` | Zero critical/high findings. Safe to dispatch to `mma-execute-plan` | Dispatch directly |
| `partial` | High findings, no critical. May execute but results are ambiguous | Review before dispatching |
| `blocked` | Critical findings. Would silently fail or mis-edit code | Fix the plan before dispatching |

### Plan structure (what the worker produces)

The plan file follows this structure:
- **Header:** Goal, Architecture, Tech Stack, Ground truth at HEAD
- **File Structure:** complete tree of all files to create/modify/test
- **Tracks:** logical groupings (2-6 tasks per track)
- **Tasks:** TDD structure (failing test → verify fail → implement → verify pass)
- **Track verification subsets** between track boundaries

## Natural next step

The plan is written. Usual next moves (soft suggestions — none forced):
- **Audit it against the codebase** → `mma-audit` (subtype: plan) — verify task ordering, signatures, and file paths before execution.
- **Execute it** → `mma-execute-plan` — implement the tasks on a worker.

## Best practices

- **One spec per plan.** Pass exactly one spec file. Multi-spec plans produce unfocused output.
- **Audit the plan after.** Run `mma-audit subtype:plan` on the produced plan for additional verification beyond the built-in reviewer.
- **Execute via `mma-execute-plan`.** The plan structure is designed for `mma-execute-plan` task matching — task headings map directly.

## Common pitfalls

❌ **Passing a brain dump instead of a spec.** The worker needs structured requirements to produce a correct plan. An unstructured prompt produces a vague plan. **Fix:** write a formal spec first via `mma-spec` or `mma-brainstorm`, then pass the spec file.

❌ **Using `target.inline` without `outputPath`.** The worker cannot derive a filename from inline content — provide `outputPath` explicitly.

❌ **Skipping `mma-audit subtype:plan` after.** The built-in reviewer checks 12 perspectives, but a standalone plan audit provides a second independent verification pass. **Fix:** dispatch `mma-audit subtype:plan` on the produced plan file before executing.

## Multi-repo mode (parent-aware)

In multi-repo mode, `/mma-flow` fans out **one** `mma-plan` dispatch per involved repo. Each dispatch plans
**exactly one repo**'s slice of the **shared spec** (two repo dispatches differ only in repo scope and
`outputPath`), and writes `.mma/plans/<stem>--<repo-slug>.md` under the parent workspace. Planning **one
repo** at a time keeps each plan a clean single-file `execute_plan` input. Single-project mode writes the
usual `<stem>.md`.

@include _shared/error-handling.md
