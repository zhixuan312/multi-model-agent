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
  "subtype": "default",
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
| `subtype` | `'default'` | no (defaults to `'default'`) | Reserved for future criteria sets; only `default` is wired today. |
| `filePaths` | string[] | no | All files investigated together (cross-file reasoning) |
| `contextBlockIds` | string[] | no | IDs from `mma-context-blocks` (e.g. error logs, traces) |

> Worker tier for `mma-debug` is hardcoded to `complex` and is not caller-configurable. Sending `agentType` is rejected with HTTP 400.

## Full example

```bash
BATCH=$(curl -f --show-error -s -X POST \
  -H "X-MMA-Client: $MMA_CLIENT" \
  -H "X-MMA-Main-Model: $MMA_MAIN_MODEL" \
  -H "Authorization: Bearer $TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"problem":"Tests fail on CI only","hypothesis":"Missing env var","filePaths":["/project/src/config.ts"]}' \
  "http://localhost:$PORT/debug?cwd=/project")
BATCH_ID=$(echo "$BATCH" | jq -r '.batchId')
```

@include _shared/polling.md

@include _shared/response-shape.md

## Reading the findings

The main agent reads `completed` + `message` + `findings` — the findings are the answer. For
read-only routes, `filesChanged` is always `[]` and `commitSha` is always `null`.

```json
{
  "completed": true,
  "message": "Investigation complete; 1 finding.",
  "findings": [
    { "id": "F1", "severity": "high", "category": "root-cause",
      "claim": "bcrypt binding fails on non-ASCII input in the Docker image.",
      "evidence": "Worker reproduced the failure with `pass='café'`; strace shows EINVAL on encode call.",
      "suggestion": "Normalize input to NFC form before calling bcrypt.",
      "source": "implementer" }
  ],
  "filesChanged": [],
  "commitSha": null,
  "summary": "...",
  "telemetry": { ... }
}
```

### Finding shape

Every finding has this shape:

| Field | Type | Notes |
|---|---|---|
| `id` | string | Worker-assigned, e.g. `F1`, `F2`. Stable across chain. |
| `severity` | `'critical' \| 'high' \| 'medium' \| 'low'` | 4-tier. |
| `category` | string | Topical bucket, e.g. `root-cause`, `reproduction`. |
| `claim` | string | One-sentence summary. |
| `evidence` | string ≥20 chars | Verbatim from source when grounded. |
| `suggestion?` | string | Optional fix recommendation. |
| `source` | `'implementer' \| 'reviewer'` | Who produced the finding. |

`annotatorConfidence` and `evidenceGrounded` are retired — they were v4 fields with no producers.

### Recommended rendering by the main agent

1. Show ALL findings — never silently drop. Severity and grounding are soft
   signals, not gates.
2. Default sort: severity (critical → low), then `id` ascending.
3. `severity` is the authoritative value — use it directly.
4. Mark findings with `evidence` shorter than 30 chars as "low-evidence"
   (lighter color or `(low evidence)` annotation). User decides what to do.
5. Severity-tier counts feed the dashboard.

## Best practices

This skill is one step in the larger flow described in `multi-model-agent` → "Best practices". Recipes that involve `mma-debug`:

- **Recipe B — Debug-fix-review.** `mma-debug` → `mma-delegate` (apply fix) → `mma-review` with the acceptance criteria in the brief. Strict order. Register the failing test output / reproduction log as a context block before the debug call; reuse it on the review call.

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

## Terminal context block

Every completed task automatically registers a terminal markdown context block containing the full task report (headline, root-cause analysis, and annotated findings). The `blockId` is returned in each task result as `terminalBlockId`. This block is immutable, lives for the session duration, and counts against the project's `maxEntries` quota (default 500).

**Use cases:**
- Pass debug findings to a downstream `mma-delegate` fix step
- Feed the root-cause analysis into a follow-up `mma-review` with acceptance criteria in the brief
- Carry debug context forward through the debug → fix → review chain

The block is registered server-side at task completion; no caller action is needed to create it. Delete it explicitly via `DELETE /context-blocks/:id` when no longer needed, or let it expire on session teardown.

@include _shared/error-handling.md
