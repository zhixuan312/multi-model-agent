---
name: mma-audit
description: Use when the user asks to audit a spec / plan / design doc / recommendation doc / config. Four `auditType` modes pick the lens. `default` (prose-coherence) is right for specs and requirements. `plan` (NEW 4.2.3+) verifies a code-execution plan against the actual codebase — use this before any `mma-execute-plan` dispatch. `security` / `performance` are narrow lenses for threat models / scaling specs.
when_to_use: User asks for a doc/spec/plan/config audit OR a methodology skill (superpowers:dispatching-parallel-agents, /security-review) points at one AND mmagent is running. Audit on PROSE/SPEC docs — use mma-review for source code. Audit a CODE-EXECUTION PLAN against the codebase — use auditType=plan.
version: "0.0.0-unreleased"
---

# mma-audit

## Overview

`mma-audit` sends a prose artifact to workers for structured auditing — and (4.2.3+) can also audit a code-execution plan against a real codebase via `auditType: 'plan'`.

**Two distinct uses, picked by `auditType`:**

| You're auditing… | Use… | What it checks |
|---|---|---|
| A spec, design doc, recommendation doc, post-mortem, or any **requirements / "what we want" prose** | `auditType: 'default'` | Prose-internal coherence — would a literal-following worker produce the right outcome from this prose alone? Catches ambiguity, contradictions, missing branches, drift, scope-creep. **Does NOT verify against any codebase.** |
| A **code-execution PLAN** (`docs/superpowers/plans/*.md` or similar) before running it via `mma-execute-plan` | `auditType: 'plan'` (4.2.3+) | Plan-vs-codebase coherence — for every method / type / file path / signature / import / verify command the plan names, the codebase actually contains it as described. 8 verification perspectives running in parallel. Catches the bug class the prose-coherence audit cannot see (e.g. plan says `registerBlock` but actual interface is `register`). |
| A threat model / auth spec | `auditType: 'security'` | Narrow security lens — only emits security findings. |
| A scaling design / latency-sensitive spec | `auditType: 'performance'` | Narrow performance lens — only emits perf findings. |

**Core principle (default mode):** One worker per file = no cross-file context pollution.
**Core principle (plan mode):** One worker per verification perspective (8 in parallel) = each dimension grounds independently in the codebase.

## When to Use

**Use `auditType: 'default'` when:**
- A spec / design doc / recommendation doc / post-mortem needs a critical prose read
- The artifact will subsequently be executed by a worker reading the prose alone
- You want to know: "Is this prose internally executable?"

**Use `auditType: 'plan'` when:**
- You have a written code-execution plan on disk and you're about to dispatch tasks from it via `mma-execute-plan`
- You want to know: "Will this plan actually dispatch successfully against the codebase as it exists today?"
- This is the ONLY audit mode that grounds findings against real source files

**Don't use mma-audit when:**
- The thing being audited is source code → `mma-review` (knows about types, call sites, test coverage)
- You want a quick look ("does this look right?") → just `Read` and use your judgment
- You need to verify a plan dispatches but you haven't written it yet → write the plan first, then run plan-audit on it

## Endpoint

`POST /audit?cwd=<abs-path>`

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
| `auditType` | `'default' \| 'security' \| 'performance' \| 'plan'` | no (defaults to `'default'`) | See "Picking auditType" below. `default` for spec / requirement prose. `plan` (4.2.3+) for code-execution plans audited against the codebase. |
| `filePaths` | string[] | no | Files to audit (one worker per file, parallel) |
| `contextBlockIds` | string[] | no | IDs from `mma-context-blocks` |

Either `document` or `filePaths` (or both) must be provided.

> Worker tier for `mma-audit` is hardcoded to `complex` and is not caller-configurable. Sending `agentType` is rejected with HTTP 400.

### Picking auditType

| Value | When to use |
|---|---|
| `default` (or omit the field) | **Spec / requirement / "what we want" prose.** Recommended for design docs, recommendation docs, post-mortems, audits, briefs, READMEs — any prose artifact where the question is "is this internally executable by reading the prose alone?". Does NOT verify against any codebase. |
| `plan` (4.2.3+) | **Code-execution plans being audited against a real codebase.** Single-file input (the plan markdown). Workers grep / read source files under `cwd` to verify every named symbol / path / signature / import / verify command. Per-task verdicts: `EXECUTABLE` / `PARTIAL` / `BLOCKED`. Use this BEFORE every `mma-execute-plan` dispatch — catches the bug class where the plan names a method/file that doesn't actually exist (the prose-coherence audit cannot see this). |
| `security` | Narrow opt-in. Use ONLY when you specifically want security findings and not general audit findings (e.g., a threat model where stylistic noise is unwanted). |
| `performance` | Narrow opt-in. Use ONLY when you specifically want performance findings (e.g., a scaling design where you want hot-path / latency / unbounded-loop findings only). |

**Plan vs Default — which to pick:** The artifact's NATURE decides:
- **Spec / requirements** (what we want, why) → `default`. Reviewing the prose alone is the goal.
- **Plan** (concrete tasks with code blocks, file paths, methods to call) → `plan`. The plan only matters if the codebase agrees with it.

You can run BOTH on a plan: first `default` (prose quality of the plan), then `plan` (does the plan match the codebase?). They cover orthogonal failure modes.

The legacy values `correctness`, `style`, and `general` no longer exist — they were a false dichotomy. Sending any of them returns `400 invalid_request` with a hint to use `default`.

### Plan-audit specifics

When `auditType: 'plan'`:

- `filePaths` MUST contain exactly **one entry** — the plan markdown. Sending zero or 2+ entries → `400 invalid_request` with the message: *"Plan audit takes exactly one filePath (the plan markdown). The worker discovers and verifies source files itself via its tool surface — do not pre-list source files."*
- `document` (inline content) is not used in plan mode — the plan must be on disk so workers can reference it by `?cwd=`-relative path.
- 8 sub-workers run in parallel, one per verification perspective: PATH EXISTENCE, SYMBOL EXISTENCE, SIGNATURE MATCH, IMPORT GRAPH, TEST HARNESS AVAILABILITY, STEP SEQUENCE WITHIN TASK, CROSS-TASK DEPENDENCIES, VERIFICATION COMMAND VALIDITY. Each can return zero findings ("this dimension passes") or N findings.
- The merge annotator computes a per-task verdict (`EXECUTABLE` / `PARTIAL` / `BLOCKED`) and a "Plan-Audit Summary" block at the end of the report.
- Only DISPATCH tasks that audit as `EXECUTABLE`. Fix the plan and re-audit if any task is `BLOCKED` or `PARTIAL`.

## Full example

### Default audit (spec / requirements prose)

```bash
BATCH=$(curl -f --show-error -s -X POST \
  -H "X-MMA-Client: $MMA_CLIENT" \
  -H "Authorization: Bearer $TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"auditType":"default","filePaths":["/project/docs/api-spec.md"]}' \
  "http://localhost:$PORT/audit?cwd=/project")
BATCH_ID=$(echo "$BATCH" | jq -r '.batchId')
```

### Plan audit (4.2.3+ — verify a code-execution plan against the codebase)

```bash
BATCH=$(curl -f --show-error -s -X POST \
  -H "X-MMA-Client: $MMA_CLIENT" \
  -H "Authorization: Bearer $TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"auditType":"plan","filePaths":["/project/docs/superpowers/plans/2026-05-10-feature.md"]}' \
  "http://localhost:$PORT/audit?cwd=/project")
BATCH_ID=$(echo "$BATCH" | jq -r '.batchId')
```

The terminal envelope carries per-task findings + a "Plan-Audit Summary" block at the end of `structuredReport` showing how many tasks are `EXECUTABLE` / `PARTIAL` / `BLOCKED` and the lowest-numbered blocker.

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

- **Recipe E — Plan-validate-execute (4.2.3+).** Before any `mma-execute-plan` batch, run `mma-audit` with `auditType: 'plan'` on the plan file. Read the "Plan-Audit Summary" block. If any task is `BLOCKED`, fix the plan; re-audit. Only dispatch tasks that audit as `EXECUTABLE`. Cost: comparable to a single `default` audit; saves the per-dispatch cost of workers re-discovering the same plan-vs-codebase drift. This catches the bug class where the plan's named methods/files don't actually exist in the codebase — symbols a prose-coherence audit cannot see.

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
