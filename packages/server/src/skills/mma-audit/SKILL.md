---
name: mma-audit
description: Use when the user asks to audit a spec / plan / design doc / skill file. The `subtype` field picks the criteria set. `default` (prose-coherence) is the general doc auditor. `plan` verifies a code-execution plan against the actual codebase — run this before any `mma-execute-plan` dispatch. `spec` audits requirement prose for testability and decision-trace. `skill` audits a SKILL.md against reader-effectiveness criteria.
when_to_use: User asks for a doc / spec / plan / skill audit OR a methodology skill (superpowers:dispatching-parallel-agents, /security-review) points at one AND mmagent is running. Audit on PROSE/SPEC docs — use mma-review for source code. Audit a CODE-EXECUTION PLAN against the codebase — use subtype=plan.
version: "0.0.0-unreleased"
---

# mma-audit

## Overview

`mma-audit` sends a prose artifact to workers for structured auditing. The `subtype` field picks WHICH criteria set the workers apply — every subtype runs through the same sequential-criteria read-only lifecycle, but each one carries its own criteria list, semantics, and prompt scaffolding.

**Four subtypes — picked by the kind of artifact, not by the lens you want:**

| You're auditing… | Use… | What it checks |
|---|---|---|
| A general prose artifact (design doc, recommendation, post-mortem, README) | `subtype: 'default'` | Comprehensive prose-coherence — would a literal-following worker produce the right outcome from this prose alone? Catches ambiguity, contradictions, missing branches, drift, scope-creep. **Does NOT verify against any codebase.** |
| A **code-execution PLAN** (`docs/superpowers/plans/*.md` or similar) before running it via `mma-execute-plan` | `subtype: 'plan'` | Plan-vs-codebase coherence — for every method / type / file path / signature / import / verify command the plan names, the codebase actually contains it as described. Catches the bug class the prose-coherence audit cannot see (e.g. plan says `registerBlock` but actual interface is `register`). |
| A **requirement spec** (what we want, why; success criteria) | `subtype: 'spec'` | Requirement-prose executability across 9 criteria — testability, scope explicitness AND decomposability, acceptance-criteria coverage, non-functional capture, requirement conflicts, decision-trace, assumption exposure, placeholder scan, and design-decomposition presence (architecture / components / data flow / error handling / testing). |
| A **SKILL.md** for an `mma-*` skill or comparable agent-facing playbook | `subtype: 'skill'` | Skill-file reader-effectiveness — when-to-use specificity, endpoint contract integrity, example correctness, anti-pattern coverage, link integrity. |

If you want to bias workers toward a narrow lens (security only, performance only, accessibility only), put that in the free-text `background` portion of the prompt — `subtype` is criteria machinery, not a lens selector.

## When to Use

- `subtype: 'default'` — a general prose artifact needs a critical read for internal executability (the artifact will be acted on by a worker reading the prose alone).
- `subtype: 'plan'` — you have a written code-execution plan on disk and you're about to dispatch tasks from it via `mma-execute-plan`. This is the ONLY subtype that grounds findings against real source files.
- `subtype: 'spec'` — you have a requirement / brainstorming-output spec and want to verify every requirement is testable, traceable, and unambiguous BEFORE writing the plan. Typical predecessor to `writing-plans`.
- `subtype: 'skill'` — you're authoring or revising an `mma-*` skill or comparable SKILL.md and want to know whether agents will actually read it the right way.

**Don't use mma-audit when:** the thing being audited is source code (→ `mma-review`); a 30-second `Read` would answer it; or you want to verify a plan that hasn't been written yet (write the plan first).

## Endpoint

`POST /audit?cwd=<abs-path>`

@include _shared/auth.md

## Request body

```json
{
  "document": "inline content to audit (optional if filePaths given)",
  "subtype": "default",
  "filePaths": ["/project/docs/spec.md"],
  "contextBlockIds": []
}
```

| Field | Type | Required | Notes |
|---|---|---|---|
| `document` | string | no | Inline document content |
| `subtype` | `'default' \| 'plan' \| 'spec' \| 'skill'` | no (defaults to `'default'`) | See "Picking subtype" below. |
| `filePaths` | string[] | no | Files to audit (one worker per file, parallel) |
| `contextBlockIds` | string[] | no | IDs from `mma-context-blocks` |

Either `document` or `filePaths` (or both) must be provided.

> Worker tier for `mma-audit` is hardcoded to `complex` and is not caller-configurable. Sending `agentType` is rejected with HTTP 400.

### Picking subtype

| Value | When to use |
|---|---|
| `default` (or omit the field) | **General prose — design doc, recommendation, post-mortem, README, brief.** Comprehensive prose-coherence audit. Does NOT verify against any codebase. |
| `plan` | **Code-execution plans being audited against a real codebase.** Single-file input (the plan markdown). Workers grep / read source files under `cwd` to verify every named symbol / path / signature / import / verify command. Use this BEFORE every `mma-execute-plan` dispatch. |
| `spec` | **Requirement spec / brainstorming-output / what-we-want prose.** 9 criteria target testability, scope explicitness + decomposability, acceptance-criteria coverage, non-functional capture, requirement conflicts, decision-trace, assumption exposure, placeholder scan, and design-decomposition presence. |
| `skill` | **`SKILL.md` or comparable agent-facing playbook.** Criteria target when-to-use specificity, endpoint contract integrity, example correctness, anti-pattern coverage, link integrity. |

You can run BOTH on a plan: first `spec` or `default` (prose quality), then `plan` (does the plan match the codebase?). They cover orthogonal failure modes.

The legacy `auditType` field and its `correctness` / `style` / `general` / `security` / `performance` values no longer exist. Sending `auditType` returns `400 invalid_request`. Sending unknown `subtype` values returns `400 invalid_request` with the allowed enum.

### Plan-audit specifics

When `subtype: 'plan'`:

- `filePaths` MUST contain exactly **one entry** — the plan markdown. Sending zero or 2+ entries → `400 invalid_request` with the message: *"Plan audit takes exactly one filePath (the plan markdown). The worker discovers and verifies source files itself via its tool surface — do not pre-list source files."*
- `document` (inline content) is not used in plan mode — the plan must be on disk so workers can reference it by `?cwd=`-relative path.
- The worker runs the sequential-criteria loop with the plan-audit criteria set across 12 perspectives in three groups: **EXTERNAL CODEBASE COHERENCE** (1 PATH EXISTENCE, 2 SYMBOL EXISTENCE, 3 SIGNATURE MATCH, 4 IMPORT GRAPH, 5 TEST HARNESS AVAILABILITY, 6 STEP SEQUENCE WITHIN TASK, 7 CROSS-TASK DEPENDENCIES, 8 VERIFICATION COMMAND VALIDITY), **INTRA-PLAN STRUCTURE** (9 TASK GRANULARITY, 11 PLACEHOLDER LANGUAGE, 12 PLAN SKELETON), and **SPEC ALIGNMENT** (10 SPEC COVERAGE).
- To enable perspective 10 (SPEC COVERAGE), register the upstream spec as a context block via `mma-context-blocks` and pass its `blockId` in `contextBlockIds`. Without a spec in context, perspective 10 emits "No findings for this criterion." and the other 11 still run.
- Read the findings list. Fix the plan and re-audit if any `critical` or `high` plan-audit findings remain.

## Full example

### Default audit (general prose)

```bash
BATCH=$(curl -f --show-error -s -X POST \
  -H "X-MMA-Client: $MMA_CLIENT" \
  -H "X-MMA-Main-Model: $MMA_MAIN_MODEL" \
  -H "Authorization: Bearer $TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"subtype":"default","filePaths":["/project/docs/api-spec.md"]}' \
  "http://localhost:$PORT/audit?cwd=/project")
BATCH_ID=$(echo "$BATCH" | jq -r '.batchId')
```

### Spec audit (requirement prose)

```bash
BATCH=$(curl -f --show-error -s -X POST \
  -H "X-MMA-Client: $MMA_CLIENT" \
  -H "X-MMA-Main-Model: $MMA_MAIN_MODEL" \
  -H "Authorization: Bearer $TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"subtype":"spec","filePaths":["/project/docs/superpowers/specs/2026-05-12-feature-design.md"]}' \
  "http://localhost:$PORT/audit?cwd=/project")
```

### Skill audit (SKILL.md)

```bash
BATCH=$(curl -f --show-error -s -X POST \
  -H "X-MMA-Client: $MMA_CLIENT" \
  -H "X-MMA-Main-Model: $MMA_MAIN_MODEL" \
  -H "Authorization: Bearer $TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"subtype":"skill","filePaths":["/project/packages/server/src/skills/mma-audit/SKILL.md"]}' \
  "http://localhost:$PORT/audit?cwd=/project")
```

### Plan audit (verify a code-execution plan against the codebase)

```bash
BATCH=$(curl -f --show-error -s -X POST \
  -H "X-MMA-Client: $MMA_CLIENT" \
  -H "X-MMA-Main-Model: $MMA_MAIN_MODEL" \
  -H "Authorization: Bearer $TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"subtype":"plan","filePaths":["/project/docs/superpowers/plans/2026-05-10-feature.md"]}' \
  "http://localhost:$PORT/audit?cwd=/project")
```

@include _shared/polling.md

@include _shared/response-shape.md

## Reading the findings

The main agent reads `completed` + `message` + `findings` — the findings are the answer. For
read-only routes, `filesChanged` is always `[]` and `commitSha` is always `null`.

```json
{
  "completed": true,
  "message": "Plan audit complete; 2 findings.",
  "findings": [
    { "id": "F1", "severity": "high", "category": "path-existence",
      "claim": "Step 3 names `src/utils/foo.ts` which does not exist.",
      "evidence": "Worker grepped for the file under cwd — no match found.",
      "suggestion": "Use `src/utils/bar.ts` instead.",
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
| `category` | string | Topical bucket, e.g. `path-existence`, `prose-coherence`. |
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

@include _shared/budget-defaults.md

## Best practices

This skill is one step in the larger flow described in `multi-model-agent` → "Best practices". Recipes that involve `mma-audit`:

- **Recipe A — Audit-iterate-clean.** `mma-audit` → fix → `mma-audit` again. Sequential rounds. Register the doc via `mma-context-blocks` before round 1 and reuse the same ID across all rounds — avoids re-inlining the same content into every audit call.

- **Recipe E — Plan-validate-execute.** Before any `mma-execute-plan` batch, run `mma-audit` with `subtype: 'plan'` on the plan file. Read the findings. If any `critical` / `high` finding survives, fix the plan and re-audit. This catches the bug class where the plan's named methods/files don't actually exist in the codebase — symbols a prose-coherence audit cannot see.

- **Recipe F — Spec-then-plan-then-execute (the canonical flow).** When working from a brainstorming spec: `mma-audit` (`subtype: 'spec'`) → fix → `writing-plans` → register the spec as a context block via `mma-context-blocks` → `mma-audit` (`subtype: 'plan'`, `contextBlockIds: [specBlockId]`) → fix → `mma-execute-plan`. Spec audit covers requirement-prose executability; plan audit covers BOTH plan-vs-codebase coherence AND plan-vs-spec coverage (perspective 10 fires only when the spec is in context, which is why the context-block step is load-bearing in this recipe).

Anti-pattern alert: **`parallel-rounds-same-target`** (AP1). Three parallel audits on the same document re-flag the same issues without seeing each other's fixes. Run rounds sequentially with a fix between each.

## Common pitfalls

❌ **Auditing source code with `mma-audit`**
The auditor lacks codebase context (no type info, no call-site lookup, no test awareness). Findings are speculative. **Fix:** use `mma-review` — it pulls in surrounding source context and validates against the actual types.

❌ **Single huge `document` string instead of `filePaths`**
Inline docs lose the file boundary, so the per-file parallel split degenerates to one worker. **Fix:** save to disk first, pass `filePaths`.

❌ **Sending the legacy `auditType` field**
The field was renamed to `subtype` and the value set was narrowed. **Fix:** use `subtype` with one of `default` / `plan` / `spec` / `skill`. For "security only" / "performance only" lenses, put the bias in the free-text prompt — there is no narrow-lens subtype.

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
