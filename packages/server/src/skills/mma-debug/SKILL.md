---
name: mma-debug
description: Use when a test fails, a build breaks, or behavior is unexpected AND narrowing the root cause requires reading files, reproducing the failure, or tracing across multiple modules — the worker investigates so the main agent stays on the hypothesis
when_to_use: A failure has surfaced (test/build/runtime) AND you need investigation work — read files, reproduce, trace — OR a methodology skill (superpowers:systematic-debugging) points at the investigation step. Delegate the read/reproduce/trace; the main agent stays on the hypothesis and the fix.
version: "0.0.0-unreleased"
---

# mma-debug

## Overview

Submit a problem, context, and hypothesis to a worker for focused debugging. Unlike `mma-audit` and `mma-review`, all `target.paths` are investigated TOGETHER in a single task (not parallelized per file) — debugging needs cross-file reasoning.

**Core principle:** The hypothesis is judgment (your job). Reading files and reproducing the failure is labor (the worker's job). Pass the hypothesis as input; receive structured findings.

## When to Use

**Use when:**
- A test fails / build breaks / runtime behavior is unexpected
- The root cause likely spans 2+ files
- You have a hypothesis to test (or want the worker to suggest one)
- A methodology skill (`superpowers:systematic-debugging`) routed here

**Don't use when:**
- The error message points at one file you can read in 30 seconds → just `Read`
- You don't know what's broken yet → use `mma-investigate` first to map the area
- You already know the fix → skip debug, dispatch `mma-delegate` with the fix

## Endpoint

`POST /task?cwd=<abs-path>`

@include _shared/auth.md

## Request body

```json
{
  "type": "debug",
  "prompt": "POST /login returns 500 when password contains special characters",
  "target": {
    "paths": [
      "/project/src/auth/login.ts",
      "/project/src/auth/password.ts"
    ]
  },
  "contextBlockIds": []
}
```

| Field | Type | Required | Notes |
|---|---|---|---|
| `prompt` | string | yes | What is broken (one sentence; concrete symptom, min 1 char) |
| `target.paths` | string[] | no | All files investigated together (cross-file reasoning) |
| `contextBlockIds` | string[] | no | IDs from `mma-context-blocks` (max 2) — e.g. error logs, traces |

> Worker tier defaults to `complex`. Send `agentTier` to override if needed.

## Full example

```bash
RESULT=$(curl -f --show-error -s -X POST \
  -H "X-MMA-Client: $MMA_CLIENT" \
  -H "X-MMA-Main-Model: $MMA_MAIN_MODEL" \
  -H "Authorization: Bearer $TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"type":"debug","prompt":"Tests fail on CI only","target":{"paths":["/project/src/config.ts"]}}' \
  "http://localhost:$PORT/task?cwd=/project")
TASK_ID=$(echo "$RESULT" | jq -r '.taskId')
```

@include _shared/polling.md

@include _shared/response-shape.md

## Reading the findings

The main agent reads findings from the terminal envelope at `output.summary.findings` (NOT `output.findings` — that field does not exist). `output.summary` is the parsed refiner JSON; findings are nested inside it. Read-only routes like `mma-debug` do not produce commits — `execution.worktree` is always `null`.

### Finding shape

Every finding in `output.summary.findings` has this shape:

| Field | Type | Notes |
|---|---|---|
| `weight` | `'critical' \| 'high' \| 'medium' \| 'low'` | Severity tier. |
| `category` | string | Topical bucket, e.g. `root-cause`, `reproduction`. |
| `claim` | string | One-sentence summary. |
| `evidence` | string | Verbatim from source when grounded. |
| `file` | string or null | File path where the finding was observed. |
| `line` | number or null | Line number in the file. |

`output.summary` also includes an `answer` field with the debug narrative.

## Best practices

This skill is one step in the larger flow described in `multi-model-agent` → "Best practices". Recipes that involve `mma-debug`:

- **Recipe B — Debug-fix-review.** `mma-debug` → `mma-delegate` (apply fix) → `mma-review` with the acceptance criteria in the brief. Strict order. Register the failing test output / reproduction log as a context block before the debug call; reuse it on the review call.

Anti-pattern alert: **`inline-labor-leakage`** (AP2). If you're about to read 3+ files in main context to "understand the bug," that's the labor we delegate — call `mma-debug` with the hypothesis instead.

## Common pitfalls

❌ **Vague problem in `prompt`**
> "The login is broken"

Worker has no symptom to chase. **Fix:** specific reproducer — `"POST /login with body {user:'a@b.c', pass:'café'} returns 500 with 'invalid character' in stderr"`.

❌ **No hypothesis in `prompt`**
The worker explores blindly, often investigates the wrong area first. **Fix:** even a weak hypothesis ("might be encoding-related") narrows the search space.

❌ **Splitting one bug across multiple `mma-debug` calls**
Debug intentionally bundles `target.paths` for cross-file reasoning. Splitting defeats this. **Fix:** one call with all suspect files; if you really have N independent failures, use `mma-delegate` with N tasks.

❌ **Treating `mma-debug` as the fix step**
Debug investigates and proposes; it doesn't necessarily write the fix. **Fix:** if the worker identifies a fix, dispatch `mma-delegate` to implement it (or write it inline if you understand it).

❌ **Skipping when an error message looks self-explanatory**
Often the obvious cause isn't the real one. **Fix:** a 30-second debug pass costs less than a wrong fix that breaks something else.

## Terminal context block

Every completed **read-route** task (audit / review / debug / investigate / research) auto-registers a reusable terminal context block containing its report (headline + findings). The block id is returned on the result as **`contextBlockId`**. Write routes (delegate / execute-plan) return `contextBlockId: null` — their record is the commit, not a block. This block is immutable, lives for the session duration, and counts against the project's `maxEntries` quota (default 500).

Use it for delta follow-ups — feed prior results' block ids into a later call's `contextBlockIds`, filtering out nulls:

    contextBlockIds: priorResults.map(r => r.contextBlockId).filter((id) => id !== null)

**Use cases:**
- Pass debug findings to a downstream `mma-delegate` fix step
- Feed the root-cause analysis into a follow-up `mma-review` with acceptance criteria in the brief
- Carry debug context forward through the debug → fix → review chain

The block is registered server-side at task completion; no caller action is needed to create it. Delete it explicitly via `DELETE /context-blocks/:id` when no longer needed, or let it expire on session teardown.

## Outcome semantics

**Success vs failure:** Check `error` in the terminal envelope. `error === null` means the task succeeded — read `output.summary`. `error !== null` (with `code` + `message`) means it failed.

**Empty findings is not a failure.** A debug session with zero findings is a success — it means "I looked hard and found nothing." Check `output.summary.findings.length === 0`.

@include _shared/error-handling.md
