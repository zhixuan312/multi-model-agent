---
name: mma-debug
description: Use when a test fails, a build breaks, or behavior is unexpected AND narrowing the root cause requires reading files, reproducing the failure, or tracing across multiple modules — the worker investigates so the main agent stays on the hypothesis
when_to_use: A failure has surfaced (test/build/runtime) AND you need investigation work — read files, reproduce, trace — OR a methodology skill (superpowers:systematic-debugging) points at the investigation step. Delegate the read/reproduce/trace; the main agent stays on the hypothesis and the fix.
version: "0.0.0-unreleased"
---

# mma-debug

## Overview

Submit a problem, context, and hypothesis to a worker for focused debugging. Unlike `mma-audit` and `mma-review`, all `filePaths` are investigated TOGETHER in a single task (not parallelized per file) — debugging needs cross-file reasoning.

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

`POST /debug?cwd=<abs-path>`

@include _shared/auth.md

## Request body

```json
{
  "problem": "POST /login returns 500 when password contains special characters",
  "context": "Regression introduced in commit abc123; only affects production config",
  "hypothesis": "The bcrypt binding fails on non-ASCII input in the Docker image",
  "filePaths": [
    "/project/src/auth/login.ts",
    "/project/src/auth/password.ts"
  ],
  "contextBlockIds": []
}
```

| Field | Type | Required | Notes |
|---|---|---|---|
| `problem` | string | yes | What is broken (one sentence; concrete symptom) |
| `context` | string | no | Background — what changed recently, what works, what doesn't |
| `hypothesis` | string | no | Your initial theory; worker tests it first, then explores |
| `filePaths` | string[] | no | All files investigated together (cross-file reasoning) |
| `contextBlockIds` | string[] | no | IDs from `mma-context-blocks` (e.g. error logs, traces) |

## Full example

```bash
BATCH=$(curl -f --show-error -s -X POST \
  -H "Authorization: Bearer $TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"problem":"Tests fail on CI only","hypothesis":"Missing env var","filePaths":["/project/src/config.ts"]}' \
  "http://localhost:$PORT/debug?cwd=/project")
BATCH_ID=$(echo "$BATCH" | jq -r '.batchId')
```

@include _shared/polling.md

@include _shared/response-shape.md

## Best practices

This skill is one step in the larger flow described in `multi-model-agent` → "Best practices". Recipes that involve `mma-debug`:

- **Recipe B — Debug-fix-verify.** `mma-debug` → `mma-delegate` (apply fix) → `mma-verify`. Strict order. Register the failing test output / reproduction log as a context block before the debug call; reuse on verify.

Anti-pattern alert: **`inline-labor-leakage`** (AP2). If you're about to read 3+ files in main context to "understand the bug," that's the labor we delegate — call `mma-debug` with the hypothesis instead.

## Common pitfalls

❌ **Vague `problem`**
> "The login is broken"

Worker has no symptom to chase. **Fix:** specific reproducer — `"POST /login with body {user:'a@b.c', pass:'café'} returns 500 with 'invalid character' in stderr"`.

❌ **No `hypothesis`**
The worker explores blindly, often investigates the wrong area first. **Fix:** even a weak hypothesis ("might be encoding-related") narrows the search space.

❌ **Splitting one bug across multiple `mma-debug` calls**
Debug intentionally bundles `filePaths` for cross-file reasoning. Splitting defeats this. **Fix:** one call with all suspect files; if you really have N independent failures, use `mma-delegate` with N tasks.

❌ **Treating `mma-debug` as the fix step**
Debug investigates and proposes; it doesn't necessarily write the fix. **Fix:** if the worker identifies a fix, dispatch `mma-delegate` to implement it (or write it inline if you understand it).

❌ **Skipping when an error message looks self-explanatory**
Often the obvious cause isn't the real one. **Fix:** a 30-second debug pass costs less than a wrong fix that breaks something else.

@include _shared/error-handling.md
