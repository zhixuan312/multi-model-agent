---
name: mma-audit
description: Use when the user asks to audit a spec, plan, design doc, recommendation doc, or config — the audit checks whether a literal-following worker could execute the artifact without ambiguity, contradiction, or missing context. Default is the comprehensive sweep; narrow lenses (security/performance) exist for cases that want only one dimension.
when_to_use: User asks for a doc/spec/plan/config audit OR a methodology skill (superpowers:dispatching-parallel-agents, /security-review) points at one AND mmagent is running. Audit on PROSE/SPEC docs — use mma-review for source code.
version: "0.0.0-unreleased"
---

# mma-audit

## Overview

Send a spec, plan, design doc, or recommendation doc to a worker for structured auditing. The audit's purpose is to make the artifact **executable by a low-judgment worker** — meaning a sub-agent that follows instructions literally and cannot disambiguate. Findings target executability blockers: ambiguity, internal contradictions, unspecified branches, missing verification, overloaded terms, out-of-order steps.

**Core principle:** One worker per file = no cross-file context pollution. The aggregator (you) decides what to do with the findings.

## When to Use

**Use when:**
- A spec, plan, design doc, recommendation doc, or post-mortem needs a critical read
- The artifact will subsequently be executed by a worker (or any reader who follows it literally)
- 2+ files would benefit from parallel audit

**Don't use when:**
- The thing being audited is source code → `mma-review` (knows about types, call sites, test coverage)
- You want a quick look ("does this look right?") → just `Read` and use your judgment
- The doc references many other files the auditor must cross-reference → consider `mma-review` instead (it pulls in source context)

## Endpoint

`POST /audit?cwd=<abs-path>`

@include _shared/auth.md

## Request body

```json
{
  "document": "inline content to audit (optional if filePaths given)",
  "auditType": "default",
  "filePaths": ["/project/docs/spec.md"],
  "contextBlockIds": []
}
```

| Field | Type | Required | Notes |
|---|---|---|---|
| `document` | string | no | Inline document content |
| `auditType` | `'default' \| 'security' \| 'performance'` | no (defaults to `'default'`) | See "Picking auditType" below — `default` is right for ~90% of audits |
| `filePaths` | string[] | no | Files to audit (one worker per file, parallel) |
| `contextBlockIds` | string[] | no | IDs from `mma-context-blocks` |

Either `document` or `filePaths` (or both) must be provided.

> Worker tier for `mma-audit` is hardcoded to `complex` and is not caller-configurable. Sending `agentType` is rejected with HTTP 400.

### Picking auditType

| Value | When to use |
|---|---|
| `default` (or omit the field) | **Right answer for ~90% of audits.** Spec, plan, design doc, recommendation doc, post-mortem, audit, brief, README — any prose artifact. Sweeps the full executability + correctness + clarity taxonomy with security and performance lenses applied. |
| `security` | Narrow opt-in. Use ONLY when you specifically want security findings and not general audit findings (e.g., a threat model where stylistic noise is unwanted). |
| `performance` | Narrow opt-in. Use ONLY when you specifically want performance findings (e.g., a scaling design where you want hot-path / latency / unbounded-loop findings only). |

The legacy values `correctness`, `style`, and `general` no longer exist — they were a false dichotomy. Sending any of them returns `400 invalid_request` with a hint to use `default`.

## Full example

```bash
BATCH=$(curl -f --show-error -s -X POST \
  -H "X-MMA-Main-Model: $MAIN_MODEL" \
  -H "X-MMA-Client: $MMA_CLIENT" \
  -H "Authorization: Bearer $TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"auditType":"default","filePaths":["/project/docs/api-spec.md"]}' \
  "http://localhost:$PORT/audit?cwd=/project")
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

This skill is one step in the larger flow described in `multi-model-agent` → "Best practices". Recipes that involve `mma-audit`:

- **Recipe A — Audit-iterate-clean.** `mma-audit` → fix → `mma-audit` again. Sequential rounds. Register the doc via `mma-context-blocks` before round 1 and reuse the same ID across all rounds — avoids re-inlining the same content into every audit call.

Anti-pattern alert: **`parallel-rounds-same-target`** (AP1). Three parallel audits on the same document re-flag the same issues without seeing each other's fixes. Run rounds sequentially with a fix between each.

## Common pitfalls

❌ **Auditing source code with `mma-audit`**
The auditor lacks codebase context (no type info, no call-site lookup, no test awareness). Findings are speculative. **Fix:** use `mma-review` — it pulls in surrounding source context and validates against the actual types.

❌ **Single huge `document` string instead of `filePaths`**
Inline docs lose the file boundary, so the per-file parallel split degenerates to one worker. **Fix:** save to disk first, pass `filePaths`.

❌ **Sending legacy auditType values (`correctness`, `style`, `general`)**
These were removed — they were a false dichotomy that biased workers toward stylistic proofreading on prose artifacts. **Fix:** use `default` (or omit the field). Use `security` or `performance` only when you specifically want a narrow lens.

❌ **Re-auditing the same files round after round without delta context**
Round 2 worker has no idea what round 1 found. **Fix:** register the round 1 findings as a context block (`mma-context-blocks`) and pass `contextBlockIds` to round 2.

## Terminal context block

Every completed task automatically registers a terminal markdown context block containing the full task report (headline, annotated findings, and per-file audit notes). The `blockId` is returned in each task result as `terminalBlockId`. This block is immutable, lives for the session duration, and counts against the project's `maxEntries` quota (default 500).

**Use cases:**
- Pass round-N audit findings to round N+1 via `contextBlockIds`
- Feed audit results into a downstream `mma-delegate` fix step
- Accumulate findings across iterative audit rounds

The block is registered server-side at task completion; no caller action is needed to create it. Delete it explicitly via `DELETE /context-blocks/:id` when no longer needed, or let it expire on session teardown.

@include _shared/error-handling.md
