---
name: mma-review
description: Use when source code needs a quality / security / correctness pass — pre-merge review, post-implementation sanity check, or focused look at a small file set — and the review can run in parallel per file
when_to_use: User asks for a code review or pre-merge check, OR a methodology skill (superpowers:requesting-code-review, /review, /security-review) points at one, AND mmagent is running. Delegate so each file reviews on its own worker; the main agent only decides what to merge. Review on SOURCE CODE — use mma-audit for prose specs / configs.
version: "0.0.0-unreleased"
---

# mma-review

## Overview

mma-review is the **pre-merge gate**. Send code files (or a diff) to a worker for structured review against an executability bar: would a maintainer who reads only the verdict and the diff understand which changes are required, why each is required, and where each lives — well enough to apply the fix and re-merge without re-investigating?

Each file is reviewed independently in parallel; results are index-aligned with `filePaths`.

**Core principle:** Reviewer is a different model from the implementer — different training, different blind spots. Cross-model review catches what self-review misses. The reviewer runs against a 10-category failure-mode taxonomy (test gap, cross-file ripple, missing edge case, race, resource leak, backward-compat break, security/performance regression, implicit-contract assumption, pre-existing-bug-vs-new-regression separation) and weighs every change through the security, performance, and correctness lenses regardless of `focus`.

## When to Use

**Use when:**
- 1+ source code files just changed (post-implementation review)
- Pre-merge sanity check on a focused diff
- Security-sensitive code path (`focus: ["security"]`)
- A specialized review pass (e.g. `focus: ["performance"]` on hot-path code)

**Don't use when:**
- The thing being reviewed is prose / spec / config → `mma-audit` (better-suited prompt template)
- You want to know whether a complete branch is mergeable → run `/ultrareview` (multi-model branch review) instead
- The diff is one-line / one-character → reading inline is faster than dispatch

## How to invoke for cross-file ripple detection

The cross-file ripple pass (changed-symbol → broken caller) only fires when the worker can identify what changed. Two patterns:

- **Diff-as-input (preferred for cross-file ripple)**: pass the diff via the `code` field, plus the named files via `filePaths`. The worker treats the diff as the change-set and greps for callers of changed public symbols.
- **Files-only (static review)**: pass only `filePaths`. The worker reviews the files in their current state without a change-set, so cross-file ripple is degenerate. Test gap, missing edge case, race, leak, and security/performance findings still fire.

## Endpoint

`POST /review?cwd=<abs-path>`

@include _shared/auth.md

## Request body

```json
{
  "code": "inline code snippet (optional if filePaths given)",
  "focus": ["correctness", "security"],
  "subtype": "default",
  "filePaths": ["/project/src/auth/login.ts"],
  "contextBlockIds": []
}
```

| Field | Type | Required | Notes |
|---|---|---|---|
| `code` | string | no | Inline code snippet to review |
| `focus` | string[] | no | Any of `security`, `performance`, `correctness`, `style`. Omit for general review. |
| `subtype` | `'default'` | no (defaults to `'default'`) | Reserved for future criteria sets; only `default` is wired today. |
| `filePaths` | string[] | no | Files to review (one worker per file, parallel) |
| `contextBlockIds` | string[] | no | IDs from `mma-context-blocks` — useful for design docs the reviewer should validate against |

Either `code` or `filePaths` (or both) must be provided.

> Worker tier for `mma-review` is hardcoded to `complex` and is not caller-configurable. Sending `agentType` is rejected with HTTP 400.

## Full example

```bash
BATCH=$(curl -f --show-error -s -X POST \
  -H "X-MMA-Client: $MMA_CLIENT" \
  -H "X-MMA-Main-Model: $MMA_MAIN_MODEL" \
  -H "Authorization: Bearer $TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"focus":["security","correctness"],"filePaths":["/project/src/auth/login.ts"]}' \
  "http://localhost:$PORT/review?cwd=/project")
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
  "message": "Review complete; 3 findings.",
  "findings": [
    { "id": "F1", "severity": "critical", "category": "test-gap",
      "claim": "login.ts has no test for null username edge case.",
      "evidence": "Worker read login.ts and grepped for test files — no null-case test found.",
      "suggestion": "Add test case: `login(null) throws ValidationError`.",
      "source": "reviewer" }
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
| `category` | string | Topical bucket, e.g. `test-gap`, `cross-file-ripple`. |
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

This skill is one step in the larger flow described in `multi-model-agent` → "Best practices". Recipes that involve `mma-review`:

- **Recipe A (analog) — Review-iterate-clean.** `mma-review` → fix → `mma-review` again. Same shape as the audit recipe, applied to source code. Sequential rounds; register the file(s) via `mma-context-blocks` before round 1 and reuse the same ID across rounds.

Anti-pattern alert: **`parallel-rounds-same-target`** (AP1). Three parallel reviews of the same source file re-flag the same issues. Run rounds sequentially with a fix between each.

## Common pitfalls

❌ **Reviewing a plan/spec markdown with `mma-review`**
The reviewer is tuned for code constructs (types, call sites, test coverage). On prose it produces vague nits. **Fix:** use `mma-audit` for docs/specs, `mma-review` for source.

❌ **Omitting `focus` and getting watery findings**
A general review surfaces low-signal style nits alongside real bugs. **Fix:** specify `focus: ["correctness"]` or `["security"]` to bias the reviewer toward the dimension you care about.

❌ **Inlining the spec the reviewer should validate against**
If the reviewer needs to check the diff against a design doc, register the doc once via `mma-context-blocks` and pass the `contextBlockIds`. Inlining N times wastes tokens.

❌ **Skipping review because "I already read it"**
Self-review and cross-model review are not the same thing. The whole reason to delegate is the different blind spots. Read the findings; merge what you agree with.

## Terminal context block

Every completed task automatically registers a terminal markdown context block containing the full task report (headline, annotated findings, and per-file review notes). The `blockId` is returned in each task result as `terminalBlockId`. This block is immutable, lives for the session duration, and counts against the project's `maxEntries` quota (default 500).

**Use cases:**
- Pass round-N review findings to round N+1 via `contextBlockIds`
- Feed review results into a downstream `mma-delegate` fix step
- Accumulate findings across iterative review rounds

The block is registered server-side at task completion; no caller action is needed to create it. Delete it explicitly via `DELETE /context-blocks/:id` when no longer needed, or let it expire on session teardown.

## Outcome semantics

Every task result carries outcome fields that describe the code review's conclusion status:

| Field | Type | Meaning |
|---|---|---|
| `findingsOutcome` | `'found' \| 'clean' \| 'not_applicable'` | Answers the question: did the review uncover issues? |
| `findingsOutcomeReason` | `string \| null` | When `findingsOutcome` is set, this explains why (e.g. "Test gap: login() has no null-username case" or "Code is clean across all review criteria"). |
| `outcomeInferred` | `boolean` | `true` if the system inferred the outcome from findings count; `false` if the reviewer explicitly stated it. |
| `outcomeMalformed` | `boolean` | `true` if the outcome line was malformed and had to be repaired; `false` otherwise. |

### Enum values

- **`found`** — the review surfaced one or more issues (findings) across one or more review categories (test gap, cross-file ripple, race, leak, security, performance, etc.). This indicates the code needs rework before merge.
- **`clean`** — the review completed and found zero issues. The code passes the review bar and is safe to merge.
- **`not_applicable`** — the review could not proceed (e.g., wrong input type, missing preconditions, or system error). This is rare; most reviews resolve to `found` or `clean`.

### Empty findings ≠ failure

A crucial semantic: **empty findings does NOT mean `completed: false` or a failed review.** Finding nothing wrong is a successful review outcome — it means the code passed inspection. A review with zero findings is `completed: true` with `findingsOutcome: 'clean'`.

### Per-route legal outcomes

The legal outcomes for this route are: `['found', 'clean']`

- **`found`** — one or more issues were detected across the review categories.
- **`clean`** — zero issues were detected; the code is ready to merge.

The outcome `not_applicable` is not legal for `mma-review` (except on actual precondition failures) because a code review always produces a verdict: either issues found or clean.

@include _shared/error-handling.md
