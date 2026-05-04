---
name: mma-review
description: Use when source code needs a quality / security / correctness pass — pre-merge review, post-implementation sanity check, or focused look at a small file set — and the review can run in parallel per file
when_to_use: User asks for a code review or pre-merge check, OR a methodology skill (superpowers:requesting-code-review, /review, /security-review) points at one, AND mmagent is running. Delegate so each file reviews on its own worker; the main agent only decides what to merge. Review on SOURCE CODE — use mma-audit for prose specs / configs.
version: "0.0.0-unreleased"
---

# mma-review

## Overview

Send code files to workers for structured review. Each file is reviewed independently in parallel; results are index-aligned with `filePaths`.

**Core principle:** Reviewer is a different model from the implementer — different training, different blind spots. Cross-model review catches what self-review misses.

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

## Endpoint

`POST /review?cwd=<abs-path>`

@include _shared/auth.md

## Request body

```json
{
  "code": "inline code snippet (optional if filePaths given)",
  "focus": ["correctness", "security"],
  "filePaths": ["/project/src/auth/login.ts"],
  "contextBlockIds": []
}
```

| Field | Type | Required | Notes |
|---|---|---|---|
| `code` | string | no | Inline code snippet to review |
| `focus` | string[] | no | Any of `security`, `performance`, `correctness`, `style`. Omit for general review. |
| `filePaths` | string[] | no | Files to review (one worker per file, parallel) |
| `contextBlockIds` | string[] | no | IDs from `mma-context-blocks` — useful for design docs the reviewer should validate against |

Either `code` or `filePaths` (or both) must be provided.

> Worker tier for `mma-review` is hardcoded to `complex` and is not caller-configurable. Sending `agentType` is rejected with HTTP 400.

## Full example

```bash
BATCH=$(curl -f --show-error -s -X POST \
  -H "Authorization: Bearer $TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"focus":["security","correctness"],"filePaths":["/project/src/auth/login.ts"]}' \
  "http://localhost:$PORT/review?cwd=/project")
BATCH_ID=$(echo "$BATCH" | jq -r '.batchId')
```

@include _shared/polling.md

@include _shared/response-shape.md

## Reading the findings (3.10.5+)

The terminal envelope's `results[N].annotatedFindings` is a list of structured
findings the reviewer extracted and scored from the implementer's narrative.
Every finding has the same shape:

| Field | Type | Notes |
|---|---|---|
| `id` | string | Reviewer-assigned, e.g. `F1`, `F2`. |
| `severity` | `'critical' \| 'high' \| 'medium' \| 'low'` | 4-tier. |
| `claim` | string | One-sentence summary. |
| `evidence` | string ≥20 chars | Quoted from worker output when grounded. |
| `suggestion?` | string | Optional fix recommendation. |
| `annotatorConfidence` | `number \| null` | 0–100 from the reviewer; `null` when emitted via deterministic fallback. |
| `evidenceGrounded` | boolean | True when `evidence` is a verbatim substring of worker output. |

### Verdict states (`qualityReviewVerdict`)

- `'annotated'` — every finding is structured. May be reviewer-emitted (with
  numeric `annotatorConfidence`) or deterministic-fallback (with
  `annotatorConfidence: null`). The route ALWAYS reaches `'annotated'` unless
  the reviewer call itself fails transport.
- `'skipped'` — kill switch (`MMAGENT_READ_ONLY_REVIEW=disabled`).
- `'error'` — only when the reviewer call fails transport (network / 5xx).

### Recommended rendering by the main agent

1. Show ALL findings — never silently drop. Confidence and grounding are
   soft signals, not gates.
2. Default sort: severity (critical → low) then `annotatorConfidence` desc
   (nulls last).
3. `severity` is the reviewer's authoritative final value — use it directly.
4. Mark findings with `evidenceGrounded: false` or
   `annotatorConfidence < 70` as "lower-trust" (collapsed section, lighter
   color, or `(low confidence)` annotation). User decides what to do.
5. Severity-tier counts feed the dashboard via V3 `findingsBySeverity`.

@include _shared/budget-defaults.md

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

@include _shared/error-handling.md
