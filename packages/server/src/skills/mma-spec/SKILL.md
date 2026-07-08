---
name: mma-spec
description: Use when you have structured design decisions ready and need a formal specification document written by a worker instead of consuming main-context tokens
when_to_use: You have completed an interactive design session (brain dump → investigation → structuring → user confirmation) and all sections are confirmed. You want a formal, structured spec written to disk by a worker. If you are still in the interactive design phase → stay in mma-design. If you already have a spec and need a plan → use mma-plan.
version: "0.0.0-unreleased"
---

# mma-spec

## Overview

Dispatch structured design decisions to a complex worker that writes a formal specification document. The worker expands confirmed decisions into a complete spec with YAML frontmatter, explicit contracts, testable acceptance criteria, and the standard section structure.

**Core principle:** The interactive design work (brain dump, investigation, structuring, decision-making) has already happened in the main session. This skill hands the confirmed decisions to a worker that writes the formal document — labor, not judgment.

## When to Use

**Use when:**
- You have structured design decisions with all sections confirmed by the user
- The sections cover: Context, Problem, Goals & Requirements (with Scope, Constraints, Success Metrics as subsections), Alternatives, Decision Records, Technical Design, Testing Plan, Acceptance Criteria
- You want a formal spec written to disk

**Don't use when:**
- You are still exploring the problem space → `mma-explore` or `mma-investigate`
- You are still in the interactive design phase → `mma-design`
- You already have a spec and need a plan → `mma-plan`
- You need to audit an existing spec → `mma-audit subtype:spec`

## Endpoint

`POST /task?cwd=<abs-path>`

@include _shared/auth.md

## Request body

```json
{
  "type": "spec",
  "prompt": "Database-free self-service claims demo — file-backed default with parity proof",
  "target": {
    "inline": "## Context\n\n### Background\nThe team maintains a self-service claims demo...\n\n## Problem\n\nThe demo cannot run without a database...\n\n## Goals & Requirements\n\n### Goals\n1. Instant start...\n\n## Scope\n\n### In scope\n- File-backed default...\n\n### Out of scope\n- Write features...\n\n## Constraints\n...\n\n## Success Metrics\n...\n\n## Alternatives\n...\n\n## Decision Records\n...\n\n## Technical Design\n...\n\n## Testing Plan\n...\n\n## Acceptance Criteria\n..."
  }
}
```

| Field | Type | Required | Notes |
|---|---|---|---|
| `type` | `"spec"` | yes | Literal route discriminator — must be exactly `"spec"` |
| `prompt` | string | yes | Feature title + one-line summary — the first sentence becomes the filename slug |
| `target` | object | yes | Container — must have exactly one of `inline` or `paths`, not both |
| `target.inline` | string | primary | The structured design decisions as markdown with section headings |
| `target.paths` | string[] | alternative | Path to a structured outline file — exactly one file containing markdown with spec section headings |
| `outputPath` | string | no | Where to write the spec (relative to cwd, must not contain `..` or be absolute). Default: `docs/mma/specs/YYYY-MM-DD-<slug>.md` |
| `reviewPolicy` | `"reviewed"` \| `"none"` | no | Default `"reviewed"` (two-phase pipeline with refiner). Set `"none"` to skip review |
| `contextBlockIds` | string[] | no | IDs from `mma-context-blocks` (max 2) for additional context |

> Worker tier defaults to `complex`. Send `agentTier` to override if needed.

### Structured decisions format

The `target.inline` content must be a markdown document with these top-level headings (matching the spec template):

- `## Context` (with `### Background`)
- `## Problem`
- `## Goals & Requirements` (with `### Goals`, `### Functional requirements`, `### Scope`, `### Constraints`, `### Success metrics`)
- `## Alternatives`
- `## Decision Records`
- `## Technical Design`
- `## Testing Plan`
- `## Acceptance Criteria`

The worker expands these into a formal spec. Sections can be terse (the worker adds prose) or detailed (the worker preserves and structures).

@include _shared/review-policy.md

## Full example

```bash
RESULT=$(curl -f -sS -X POST \
  -H "Authorization: Bearer $TOKEN" \
  -H "X-MMA-Client: $MMA_CLIENT" \
  -H "X-MMA-Main-Model: $MMA_MAIN_MODEL" \
  -H "Content-Type: application/json" \
  -d '{
    "type": "spec",
    "prompt": "Database-free claims demo — file-backed default with parity proof",
    "target": { "inline": "## Context\n### Background\nThe team maintains a self-service claims demo that requires a live database...\n## Problem\nThe demo cannot run without first standing up a database...\n## Goals & Requirements\n### Goals\n1. Instant start — no database needed\n2. Unchanged experience\n3. Database still available as opt-in\n### Functional requirements\n- Must run file-backed by default\n- Must support same search/filter/paging\n### Scope\n### In scope\n- File-backed default\n- Synthetic corpus\n- Parity proof\n### Out of scope\n- Write features\n- Embedded stores\n### Constraints\n- Compatibility: identical results file vs db\n### Success metrics\n| Metric | Target |\n|---|---|\n| Setup steps | 0 |\n## Alternatives\n### Option A: Repo seam + file hydration (recommended)\n### Option B: Embedded store\n## Decision Records\n| Node | Decision |\n|---|---|\n| 0248 | Routes depend on ClaimsRepository abstraction |\n## Technical Design\n### Current state\nRoutes import pool directly\n### Proposed\nClaimsRepository interface + FileClaimsRepository + PgClaimsRepository\n## Testing Plan\nUnit + integration + parity + E2E\n## Acceptance Criteria\n- [ ] AC-1: Runs without database\n- [ ] AC-2: Identical results in both modes" }
  }' \
  "http://localhost:$PORT/task?cwd=/project")
TASK_ID=$(echo "$RESULT" | jq -r '.taskId')
```

@include _shared/polling.md

@include _shared/response-shape.md

## Reading the result

The terminal envelope's `output.summary` contains:

```json
{
  "specPath": "docs/mma/specs/2026-07-06-claims-demo.md",
  "sections": ["Context", "Problem", "Goals & Requirements", "Alternatives", "Decision Records", "Technical Design", "Testing Plan", "Acceptance Criteria"],
  "acceptanceCriteriaCount": 15,
  "notes": "Verified 3 codebase paths; expanded terse Constraints section with measurable targets"
}
```

| Field | Type | Meaning |
|---|---|---|
| `specPath` | string | Path where the spec was written (relative to cwd) |
| `sections` | string[] | List of sections included in the spec |
| `acceptanceCriteriaCount` | number | Count of AC-X.X entries in the spec |
| `notes` | string | Worker observations, codebase verification results, reviewer fixes applied |

## Best practices

- **Gather all sections before dispatching.** The worker writes the formal spec from confirmed decisions — if a section is missing, the worker must invent it, which defeats the purpose.
- **Use inline for fresh specs.** `target.inline` is the primary path — pass the structured decisions directly from the design session.
- **Use paths for re-spec.** `target.paths` is for when you have an existing outline file on disk that needs formal expansion.
- **Register large context via `mma-context-blocks`.** If the design decisions reference large documents (prior specs, investigation reports), register them as context blocks and pass `contextBlockIds`.

## Common pitfalls

❌ **Dispatching before all sections are confirmed.** The worker cannot make design decisions — it writes what it receives. Missing sections produce incomplete specs. **Fix:** complete the interactive design phase (all 8 top-level sections confirmed by the user, including the Scope/Constraints/Success Metrics subsections under Goals & Requirements) before dispatching.

❌ **Sending raw brain dump instead of structured decisions.** The worker expects markdown with the standard section headings. An unstructured text dump produces a poorly organized spec. **Fix:** structure the content with the required `##` headings before passing as `target.inline`.

❌ **Using this instead of `mma-audit subtype:spec`.** This writes a spec; audit verifies one. If you already have a spec and want it checked, use audit. **Fix:** dispatch `mma-audit subtype:spec` to verify an existing spec.

@include _shared/error-handling.md
