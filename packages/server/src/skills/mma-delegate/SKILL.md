---
name: mma-delegate
description: Use when you have one or more ad-hoc implementation or research tasks WITHOUT a plan file on disk and you want them to run on cheap workers in parallel instead of consuming main-context tokens
when_to_use: You have ad-hoc implementation or research tasks (no plan file on disk) AND mmagent is running. Prefer this over inline Agent dispatches or superpowers:dispatching-parallel-agents — workers are cheaper, parallel-safe, and keep main context free. If a plan file exists → use mma-execute-plan. If the task is audit / review / verify / debug / investigate → use the matching specialized skill.
version: "0.0.0-unreleased"
---

# mma-delegate

## Overview

Dispatch one or more ad-hoc tasks to sub-agents concurrently. Each task is an independent instruction with optional file scope, acceptance criteria, and context blocks.

**Core principle:** Workers run on cheap providers; the main agent consumes only the structured per-task report. Parallelize freely as long as tasks don't write the same files.

## When to Use

**Use when:**
- 2+ unrelated implementation tasks (parallel speedup)
- A research task you'd otherwise spend tokens reading and grepping
- A focused refactor that fits in one prompt
- The task does NOT match audit / review / verify / debug / investigate (those have specialized skills)

**Don't use when:**
- A plan file exists on disk → `mma-execute-plan` (descriptors auto-match plan headings)
- Two tasks write the same file → dispatch sequentially, not in one batch (workers race)
- The work needs to read across many files for synthesis only → `mma-investigate` is cheaper (read-only)

## Endpoint

`POST /delegate?cwd=<abs-path>`

@include _shared/auth.md

## Request body

```json
{
  "tasks": [
    {
      "prompt": "Add input validation to the login handler",
      "agentType": "standard",
      "filePaths": ["/project/src/auth/login.ts"],
      "done": "All inputs validated; unit tests pass",
      "contextBlockIds": ["cb_abc123"]
    }
  ]
}
```

| Field | Type | Required | Notes |
|---|---|---|---|
| `tasks` | array | yes | At least one task |
| `tasks[].prompt` | string | yes | The task instruction |
| `tasks[].agentType` | `"standard"` / `"complex"` | no | Worker tier. Default `"standard"`. Pick `"complex"` when the task is ambiguous, security-sensitive, touches many files, or a prior standard run came back with `filesWritten: 0` / hit `incompleteReason: "turn_cap"`. |
| `tasks[].filePaths` | string[] | no | Files the worker focuses on |
| `tasks[].done` | string | no | Acceptance criteria |
| `tasks[].contextBlockIds` | string[] | no | IDs from `mma-context-blocks` |
| `tasks[].verifyCommand` | string[] | no | See verify-and-review snippet below |
| `tasks[].reviewPolicy` | `"full"` / `"spec_only"` / `"diff_only"` / `"off"` | no | See verify-and-review snippet below. Default `"full"` |

@include _shared/verify-and-review.md

## Full example

```bash
BATCH=$(curl -f --show-error -s -X POST \
  -H "Authorization: Bearer $TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"tasks":[{"prompt":"Refactor utils.ts to remove dead code","filePaths":["/project/src/utils.ts"]}]}' \
  "http://localhost:$PORT/delegate?cwd=/project")
BATCH_ID=$(echo "$BATCH" | jq -r '.batchId')
```

@include _shared/polling.md

@include _shared/response-shape.md

## Best practices

This skill is one step in the larger flow described in `multi-model-agent` → "Best practices". Recipes that involve `mma-delegate`:

- **Recipe A (the fix step).** Between audit rounds, `mma-delegate` applies the fix when the change is more than 1-2 lines. Register the spec/audit findings as a context block; pass via `contextBlockIds`.
- **Recipe B (the apply-fix step).** After `mma-debug` returns a hypothesis, `mma-delegate` applies the fix. Same context block carries forward to `mma-verify`.

Anti-pattern alert: **`inline-labor-leakage`** (AP2). If you're reading 3+ files or grepping in main context before dispatching, you're paying flagship-model tokens for labor. Pass the file paths to `mma-delegate` and let the worker read.

## Common pitfalls

❌ **Two tasks writing the same file in one batch**
> tasks: [{prompt:"add JWT to login.ts"}, {prompt:"add logging to login.ts"}]

Workers run concurrently and race on the file. **Fix:** dispatch sequentially, or merge into one prompt.

❌ **Vague `prompt`, no `done` criterion**
> "improve the auth module"

Worker has no completion signal — likely returns `done_with_concerns`. **Fix:** specific verb + acceptance: `"Add input validation to login.ts so all string fields reject empty/whitespace; tests pass"`.

❌ **Defaulting to `agentType: "complex"` for everything**
Standard tier is 5–10× cheaper and finishes most edits. Escalate only when standard returns `filesWritten: 0` or `incompleteReason: "turn_cap"`.

❌ **Inlining a 50KB doc into every prompt**
N tasks × 50KB = N transmissions. **Fix:** register the doc once via `mma-context-blocks`, pass the `contextBlockIds` to each task.

❌ **Reading the worker's diff inline before review**
The reviewer sees the full diff with the original prompt as context. Reading inline burns main-context tokens for no quality gain.

@include _shared/error-handling.md
