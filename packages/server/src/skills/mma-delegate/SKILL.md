---
name: mma-delegate
description: Use when you have an ad-hoc implementation or research task WITHOUT a plan file on disk and you want it to run on a cheap worker instead of consuming main-context tokens
when_to_use: You have ad-hoc implementation or research tasks (no plan file on disk) AND mma is running. Prefer this over inline Agent dispatches — workers are cheaper and keep main context free. If a plan file exists → use mma-execute-plan. If the task is audit / review / verify / debug / investigate → use the matching specialized skill.
version: "0.0.0-unreleased"
---

# mma-delegate

## Overview

Dispatch a single ad-hoc task to a worker. The request is flat — prompt, target paths, acceptance criteria, and optional context blocks.

**Core principle:** Workers run on cheap providers; the main agent consumes only the structured per-task report. Each request dispatches one task; callers send multiple requests for multiple tasks.

## When to Use

**Use when:**
- An implementation task you want off the main context (send one request per task)
- A research task you'd otherwise spend tokens reading and grepping
- A focused refactor that fits in one prompt
- The task does NOT match audit / review / verify / debug / investigate (those have specialized skills)

**Don't use when:**
- A plan file exists on disk → `mma-execute-plan` (descriptors auto-match plan headings)
- Two sequential tasks that share files → dispatch one after the other (each is a separate request)
- The work needs to read across many files for synthesis only → `mma-investigate` is cheaper (read-only)

## Dispatch

Call the `mma_run` MCP tool with `cwd` and a `request` body (below). If the `mma_run` MCP tool
is not available in this session, run `mma clients`.

## Request body

```json
{
  "type": "delegate",
  "prompt": "Add input validation to the login handler",
  "target": { "paths": ["/project/src/auth/login.ts"] },
  "done": "All inputs validated; unit tests pass",
  "contextBlockIds": ["cb_abc123"],
  "reviewPolicy": "reviewed"
}
```

| Field | Type | Required | Notes |
|---|---|---|---|
| `prompt` | string | yes | The task instruction |
| `target` | object | no | Target scope for the worker |
| `target.paths` | string[] | no | Files the worker focuses on |
| `done` | string | no | Acceptance criteria |
| `contextBlockIds` | string[] | no | IDs from `mma-context-blocks` (max 2) |
| `reviewPolicy` | `"reviewed"` / `"none"` | no | See review-policy snippet below. Default `"reviewed"` |

@include _shared/review-policy.md

## Full example

Call `mma_run` with:

```json
{ "cwd": "/project", "request": { "type": "delegate", "prompt": "Refactor utils.ts to remove dead code", "target": { "paths": ["/project/src/utils.ts"] } } }
```

## Response shapes

`mma_run` returns either the terminal envelope inline (short tasks) or a `{ taskId, type, cwd }`
handle for longer ones — poll with `mma_task_get`, block with `mma_task_wait`, cancel with
`mma_task_cancel`. See `_shared/response-shape.md` below for the full envelope shape and the tool
call error shape.

@include _shared/response-shape.md

## Best practices

This skill is one step in the larger flow described in `multi-model-agent` → "Best practices". Recipes that involve `mma-delegate`:

- **Recipe A (the fix step).** Between audit rounds, `mma-delegate` applies the fix when the change is more than 1-2 lines. Register the spec/audit findings as a context block; pass via `contextBlockIds`.
- **Recipe B (the apply-fix step).** After `mma-debug` returns a hypothesis, `mma-delegate` applies the fix. Same context block carries forward to a follow-up `mma-review` if you want acceptance-criteria checking.

Anti-pattern alert: **`inline-labor-leakage`** (AP2). If you're reading 3+ files or grepping in main context before dispatching, you're paying flagship-model tokens for labor. Pass the file paths to `mma-delegate` and let the worker read.

## Common pitfalls

❌ **Two delegate calls writing the same file concurrently**

Workers run concurrently and race on the file. **Fix:** dispatch sequentially, or merge into one prompt.

❌ **Re-inlining large content across calls**
N calls × 50KB = N transmissions. **Fix:** register the doc once via `mma-context-blocks`, pass the `contextBlockIds` to each call.

❌ **Reading the worker's diff inline before review**
The reviewer sees the full diff with the original prompt as context. Reading inline burns main-context tokens for no quality gain.

## Terminal context block

Write-route tasks (delegate / execute-plan) do NOT register a terminal context block — their durable record is the commit the engine makes on your branch, plus `output.filesChanged`. The result's `contextBlockId` is always `null` for these routes. Read routes (audit / review / debug / investigate / research) return a non-null `contextBlockId`; see those skills for the delta-follow-up recipe.


## Non-git targets

Delegate always runs **in-place**: it edits the `cwd` you submit, on whatever branch that checkout
already has, under the cwd-only sandbox. The engine never creates a branch or a worktree — **you own
the branch**, so cut and check it out before dispatching.

For a **git** target the engine commits your work on that branch after the worker finishes, and
`output.filesChanged` is measured from that commit (`git diff --name-only`), not self-reported. For a
**non-git** target the in-place edits are simply left on disk and there is no commit, no branch, no
PR. Git is never forced.

Workers may not run git themselves (only `status` / `log` / `diff` / `show` are permitted) — the
engine owns the commit, from outside the worker sandbox.
