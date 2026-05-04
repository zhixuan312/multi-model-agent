---
name: mma-verify
description: Use when work is "complete" and you need to confirm acceptance criteria are actually met before claiming so to the user — each checklist item verified independently against the work
when_to_use: The user (or a methodology skill like superpowers:verification-before-completion) needs acceptance-criteria checked against implemented work BEFORE claiming success. Delegate so each checklist item gets independent evidence-gathering on a worker. Use this BEFORE saying "done" — never after.
version: "0.0.0-unreleased"
---

# mma-verify

## Overview

Submit work product and a checklist to workers for independent verification. Each checklist item is verified in parallel; results are index-aligned with the input.

**Core principle:** Self-verification ("I read the files; they look correct") has no external validation. Workers check independently and return evidence (or absence of it) per item.

## When to Use

**Use when:**
- You're about to claim a task is "done" and need evidence per acceptance item
- A methodology skill (superpowers:verification-before-completion) routed here
- The user gave a checklist and asked you to confirm each item

**Don't use when:**
- The "checklist" is one item — read inline, faster than dispatch
- You don't have explicit acceptance criteria — write them first, then dispatch
- The work hasn't been done yet — verification is a post-condition, not a pre-condition

## Endpoint

`POST /verify?cwd=<abs-path>`

@include _shared/auth.md

## Request body

```json
{
  "work": "inline description of the work (optional if filePaths given)",
  "checklist": [
    "All public functions have JSDoc comments",
    "No console.log statements remain",
    "Unit tests cover the happy path and at least one error case"
  ],
  "filePaths": ["/project/src/utils.ts"],
  "contextBlockIds": []
}
```

| Field | Type | Required | Notes |
|---|---|---|---|
| `work` | string | no | Inline work-product description (e.g. summary of what changed) |
| `checklist` | string[] | yes | At least one item — each item verified by its own worker |
| `filePaths` | string[] | no | Files to verify against (workers can read them) |
| `contextBlockIds` | string[] | no | IDs from `mma-context-blocks` (e.g. the spec the work was supposed to satisfy) |

> Worker tier for `mma-verify` is hardcoded to `complex` and is not caller-configurable. Sending `agentType` is rejected with HTTP 400.

## Full example

```bash
BATCH=$(curl -f --show-error -s -X POST \
  -H "Authorization: Bearer $TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"checklist":["Error handler exists","Tests pass"],"filePaths":["/project/src/handler.ts"]}' \
  "http://localhost:$PORT/verify?cwd=/project")
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

This skill is one step in the larger flow described in `multi-model-agent` → "Best practices". Recipes that involve `mma-verify`:

- **Recipe B — Debug-fix-verify.** `mma-debug` → `mma-delegate` (fix) → `mma-verify`. Verify checks acceptance criteria against the implemented work. Reuse the context block registered for the debug call.

Anti-pattern alert: **`parallel-rounds-same-target`** (AP1, verify analog). Two parallel `mma-verify` calls on the unchanged checklist re-flag the same gaps. Run verify → fix → re-verify sequentially instead.

## Common pitfalls

❌ **Vague checklist items**
> "Code is good"

The worker can't gather evidence for "good". **Fix:** specific, falsifiable criteria — `"Function parseConfig has at least 3 unit tests covering: missing field, malformed JSON, empty file"`.

❌ **Verifying without `filePaths`**
Worker has nothing to read; verdict is speculative. **Fix:** always pass the file(s) the work landed in.

❌ **Treating verify as the implementation step**
Verify CHECKS work; it doesn't DO work. If a checklist item fails, dispatch `mma-delegate` to fix it, then re-verify.

❌ **Skipping verify because "tests pass"**
Tests verify the test cases that exist. Verify checks the acceptance criteria — which often include things tests don't (docs updated, no debug-print left, etc.).

@include _shared/error-handling.md
