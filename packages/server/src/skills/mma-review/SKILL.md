---
name: mma-review
description: Use when source code needs a quality / security / correctness pass — pre-merge review, post-implementation sanity check, or focused look at a small file set — and the review can run in parallel per file
when_to_use: User asks for a code review or pre-merge check, OR a methodology skill (superpowers:requesting-code-review, /review, /security-review) points at one, AND mma is running. Delegate so each file reviews on its own worker; the main agent only decides what to merge. Review on SOURCE CODE — use mma-audit for prose specs / configs.
version: "0.0.0-unreleased"
---

# mma-review

## Overview

mma-review is the **pre-merge gate**. Send code files (or a diff) to a worker for structured review against an executability bar: would a maintainer who reads only the verdict and the diff understand which changes are required, why each is required, and where each lives — well enough to apply the fix and re-merge without re-investigating?

Each file is reviewed independently in parallel; results are index-aligned with `target.paths`.

**Core principle:** Reviewer is a different model from the implementer — different training, different blind spots. Cross-model review catches what self-review misses. The reviewer runs against a 10-category failure-mode taxonomy (test gap, cross-file ripple, missing edge case, race, resource leak, backward-compat break, security/performance regression, implicit-contract assumption, pre-existing-bug-vs-new-regression separation) and weighs every change through the security, performance, and correctness lenses.

## When to Use

**Use when:**
- 1+ source code files just changed (post-implementation review)
- Pre-merge sanity check on a focused diff
- Security-sensitive code path (use `prompt: "focus on security"`)
- A specialized review pass (e.g. `prompt: "focus on performance"` on hot-path code)

**Don't use when:**
- The thing being reviewed is prose / spec / config → `mma-audit` (better-suited prompt template)
- You want to know whether a complete branch is mergeable → run `/ultrareview` (multi-model branch review) instead
- The diff is one-line / one-character → reading inline is faster than dispatch

## How to invoke for cross-file ripple detection

The cross-file ripple pass (changed-symbol → broken caller) only fires when the worker can identify what changed. Two patterns:

- **Diff-as-input (preferred for cross-file ripple)**: pass the diff via the `target.inline` field, plus the named files via `target.paths`. The worker treats the diff as the change-set and greps for callers of changed public symbols.
- **Files-only (static review)**: pass only `target.paths`. The worker reviews the files in their current state without a change-set, so cross-file ripple is degenerate. Test gap, missing edge case, race, leak, and security/performance findings still fire.

## Endpoint

`POST /task?cwd=<abs-path>`

@include _shared/auth.md

## Request body

```json
{
  "type": "review",
  "prompt": "optional review instruction or focus area",
  "target": { "paths": ["/project/src/auth/login.ts"] },
  "contextBlockIds": []
}
```

| Field | Type | Required | Notes |
|---|---|---|---|
| `prompt` | string | no | Optional instruction to focus the review (e.g. "focus on security") |
| `target.inline` | string | no | Inline code snippet to review |
| `target.paths` | string[] | no | Files to review |
| `contextBlockIds` | string[] | no | IDs from `mma-context-blocks` (max 2) — useful for design docs the reviewer should validate against |

Exactly one of `target.inline` or `target.paths` must be provided (not both).

> Worker tier defaults to `complex`. Send `agentTier` to override if needed.

## Full example

```bash
RESULT=$(curl -f --show-error -s -X POST \
  -H "X-MMA-Client: $MMA_CLIENT" \
  -H "X-MMA-Main-Model: $MMA_MAIN_MODEL" \
  -H "Authorization: Bearer $TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"type":"review","prompt":"focus on security and correctness","target":{"paths":["/project/src/auth/login.ts"]}}' \
  "http://localhost:$PORT/task?cwd=/project")
TASK_ID=$(echo "$RESULT" | jq -r '.taskId')
```

@include _shared/polling.md

@include _shared/response-shape.md

## Reading the findings

The main agent reads findings from the terminal envelope at `output.summary.findings` (NOT `output.findings` — that field does not exist). `output.summary` is the parsed refiner JSON; findings are nested inside it. Read-only routes like `mma-review` do not produce commits — `execution.worktree` is always `null`.

### Finding shape

Every finding in `output.summary.findings` has this shape:

| Field | Type | Notes |
|---|---|---|
| `weight` | `'critical' \| 'high' \| 'medium' \| 'low'` | Severity tier. |
| `category` | string | Topical bucket, e.g. `test-gap`, `cross-file-ripple`. |
| `claim` | string | One-sentence summary. |
| `evidence` | string | Verbatim from source when grounded. |
| `file` | string | File path where the finding was observed. |
| `line` | number | Line number in the file. |
| `suggestion` | string | Fix recommendation. |
| `preExisting` | boolean | `true` if the issue predates the change under review. |

### Recommended rendering by the main agent

1. Show ALL findings — never silently drop. Weight and grounding are soft
   signals, not gates.
2. Default sort: weight (critical → low).
3. `weight` is the authoritative severity — use it directly.
4. Mark findings with `evidence` shorter than 30 chars as "low-evidence"
   (lighter color or `(low evidence)` annotation). User decides what to do.
5. Weight-tier counts feed the dashboard.

## Best practices

This skill is one step in the larger flow described in `multi-model-agent` → "Best practices". Recipes that involve `mma-review`:

- **Recipe A (analog) — Review-iterate-clean.** `mma-review` → fix → `mma-review` again. Same shape as the audit recipe, applied to source code. Sequential rounds; register the file(s) via `mma-context-blocks` before round 1 and reuse the same ID across rounds.

Anti-pattern alert: **`parallel-rounds-same-target`** (AP1). Three parallel reviews of the same source file re-flag the same issues. Run rounds sequentially with a fix between each.

## Common pitfalls

❌ **Reviewing a plan/spec markdown with `mma-review`**
The reviewer is tuned for code constructs (types, call sites, test coverage). On prose it produces vague nits. **Fix:** use `mma-audit` for docs/specs, `mma-review` for source.

❌ **Omitting a focus direction and getting watery findings**
A general review surfaces low-signal style nits alongside real bugs. **Fix:** use `prompt` to bias the reviewer toward the dimension you care about (e.g. `"focus on correctness"` or `"focus on security"`).

❌ **Inlining the spec the reviewer should validate against**
If the reviewer needs to check the diff against a design doc, register the doc once via `mma-context-blocks` and pass the `contextBlockIds`. Inlining N times wastes tokens.

❌ **Skipping review because "I already read it"**
Self-review and cross-model review are not the same thing. The whole reason to delegate is the different blind spots. Read the findings; merge what you agree with.

## Terminal context block

Every completed **read-route** task (audit / review / debug / investigate / research) auto-registers a reusable terminal context block containing its report (headline + findings). The block id is returned on the result as **`contextBlockId`**. Write routes (delegate / execute-plan) return `contextBlockId: null` — their record is the commit, not a block. This block is immutable, lives for the session duration, and counts against the project's `maxEntries` quota (default 500).

Use it for delta follow-ups — feed prior results' block ids into a later call's `contextBlockIds`, filtering out nulls:

    contextBlockIds: priorResults.map(r => r.contextBlockId).filter((id) => id !== null)

**Use cases:**
- Pass round-N review findings to round N+1 via `contextBlockIds`
- Feed review results into a downstream `mma-delegate` fix step
- Accumulate findings across iterative review rounds

The block is registered server-side at task completion; no caller action is needed to create it. Delete it explicitly via `DELETE /context-blocks/:id` when no longer needed, or let it expire on session teardown.

## Outcome semantics

**Success vs failure:** Check `error` in the terminal envelope. `error === null` means the task succeeded — read `output.summary`. `error !== null` (with `code` + `message`) means it failed.

**Empty findings is not a failure.** A review with zero findings is a success — the code passed inspection. Check `output.summary.findings.length === 0`.

@include _shared/error-handling.md
