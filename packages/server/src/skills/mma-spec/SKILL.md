---
name: mma-spec
description: Use when you have structured design decisions ready and need a formal specification document written by a worker instead of consuming main-context tokens
when_to_use: You have completed an interactive design session (brain dump → investigation → structuring → user confirmation) and all sections are confirmed. You want a formal, structured spec written to disk by a worker. If you are still in the interactive design phase → stay in mma-brainstorm. If you already have a spec and need a plan → use mma-plan.
version: "0.0.0-unreleased"
---

# mma-spec

## Overview

Dispatch structured design decisions to a complex worker that writes a formal specification document. The worker expands confirmed decisions into a complete spec with YAML frontmatter, explicit contracts, testable acceptance criteria, and the standard section structure.

**Core principle:** The interactive design work (brain dump, investigation, structuring, decision-making) has already happened in the main session. This skill hands the confirmed decisions to a worker that writes the formal document — labor, not judgment.

## When to Use

**Use when:**
- You have structured design decisions with all sections confirmed by the user
- The sections cover the eight canonical components: Context, Problem, Goals & Requirements, Alternatives, Technical Design, Testing Plan, Risks & Mitigations, User Stories & Tasks
- You want a formal spec written to disk

**Don't use when:**
- You are still exploring the problem space → `mma-explore` or `mma-investigate`
- You are still in the interactive design phase → `mma-brainstorm`
- You already have a spec and need a plan → `mma-plan`
- You need to audit an existing spec → `mma-audit subtype:spec`

## Endpoint

`POST /task?cwd=<abs-path>`

@include _shared/auth.md

## Request body

```json
{
  "type": "spec",
  "prompt": "Subset-compatible spec request",
  "target": {
    "inline": "## Context\n\n### Background\n..."
  },
  "components": ["Context", "Problem", "Technical Design"]
}
```

| Field | Type | Required | Notes |
|---|---|---|---|
| `type` | `"spec"` | yes | Literal route discriminator — must be exactly `"spec"` |
| `prompt` | string | yes | Feature title + one-line summary. Its first sentence becomes the filename slug **only when self-naming** (no dated input and no explicit `outputPath`) — when a dated input is present the stem is inherited from it (see `outputPath`) |
| `target` | object | yes | Container — must have exactly one of `inline` or `paths`, not both |
| `target.inline` | string | primary | The structured design decisions as markdown with section headings |
| `target.paths` | string[] | alternative | Path(s) to structured input files. The **first** file is the authoritative confirmed decisions (markdown with spec section headings). Any **additional** files — e.g. an `exploration.md` from `mma-explore` — are **grounding/reference only**: the worker reads them for context but never treats their options / rough directions as decisions. |
| `outputPath` | string | no | Where to write the spec (relative to cwd, must not contain `..` or be absolute). When omitted, the default **inherits the stem** from the first `YYYY-MM-DD-`-prefixed entry in `target.paths` (the exploration) → `.mma/specs/<that-stem>.md`, so the exploration → spec → plan chain shares one stem; undated inputs (scratchpad scaffolds) are skipped. Falls back to `.mma/specs/<today>-<prompt-slug>.md` only when no dated input is present. Every `target.paths` entry must resolve, else the task fails `invalid_request`. |
| `components` | string[] | no | Optional subset of canonical top-level component labels. Allowed labels: `Context`, `Problem`, `Goals & Requirements`, `Alternatives`, `Technical Design`, `Testing Plan`, `Risks & Mitigations`, `User Stories & Tasks`. Omitted or empty `components` means all eight components. |
| `reviewPolicy` | `"reviewed"` \| `"none"` | no | Default `"reviewed"` (two-phase pipeline with refiner). Set `"none"` to skip review |
| `contextBlockIds` | string[] | no | IDs from `mma-context-blocks` (max 2) for additional context |

> Worker tier defaults to `complex`. Send `agentTier` to override if needed.

### Structured decisions format

The `target.inline` content must be a markdown document with any of these eight canonical top-level headings (in any order — the worker will preserve canonical order):

- `## Context`
- `## Problem`
- `## Goals & Requirements`
- `## Alternatives`
- `## Technical Design`
- `## Testing Plan`
- `## Risks & Mitigations`
- `## User Stories & Tasks`

If the `components` field is provided, only those components need to be present in the input; the worker will emit exactly the requested subset. In other words, omitted or empty `components` means all eight components. The worker expands terse sections (the worker adds prose) or preserves detailed sections.

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
    "target": { "inline": "## Context\n### Background\nThe team maintains a self-service claims demo...\n## Problem\nThe demo cannot run without first standing up a database...\n## Goals & Requirements\n### Goals\n1. Instant start — no database needed\n## Alternatives\n### Option A: Repo seam + file hydration (recommended)\n### Option B: Embedded store\n## Technical Design\n### Proposed\nClaimsRepository interface + FileClaimsRepository\n## Testing Plan\nUnit + integration + parity\n## User Stories & Tasks\n- [ ] AC-1: Runs without database" }
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
  "specPath": ".mma/specs/2026-07-06-claims-demo.md",
  "sections": ["Context", "Problem", "Goals & Requirements", "Alternatives", "Technical Design", "Testing Plan", "Risks & Mitigations", "User Stories & Tasks"],
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

## Natural next step

The spec is written and you're back in the main agent. Usual next moves (soft suggestions — none forced):
- **Audit it** → `mma-audit` (subtype: spec) — catch ambiguity or untestable requirements before planning.
- **Write the plan** → `mma-plan` — turn the spec into an ordered TDD implementation plan.

## Best practices

- **Gather all sections before dispatching.** The worker writes the formal spec from confirmed decisions — if a section is missing, the worker must invent it, which defeats the purpose.
- **Inline for small, fresh decisions.** `target.inline` is the default — pass the structured decisions directly from the design session.
- **Write a tmp scaffold file + `target.paths` once the content is large or heavily structured** (tables, code fences, many sections — roughly >8 KB). A path has no JSON-escaping surface and keeps the dispatch body small; the driver is escaping fragility, not size alone. **Write the scaffold to your scratchpad / system temp directory, never inside the target repo** (e.g. `<scratchpad>/spec-decisions.md`, not `<repo>/.mma-spec-scaffold.md`) — it's a throwaway dispatch artifact, not a project file, so keep it out of the working tree. Pass an absolute path in `target.paths`. Delete the scaffold after `specPath` returns. `target.paths` also covers re-spec from an existing outline on disk.
- **Pass upstream grounding (e.g. an `exploration.md`) as an ADDITIONAL `target.paths` file, after the decisions.** `target` is exactly-one-of `inline`/`paths`, so when the worker should have both the decisions and a grounding file, put both in `target.paths` — decisions **first** (authoritative, what it expands), grounding **second** (context only; the worker never treats its rough options as decisions).
- **Register large context via `mma-context-blocks`.** If the design decisions reference large documents (prior specs, investigation reports), register them as context blocks and pass `contextBlockIds`.

## Common pitfalls

❌ **Dispatching before all sections are confirmed.** The worker cannot make design decisions — it writes what it receives. Missing sections produce incomplete specs. **Fix:** complete the interactive design phase (all requested top-level components confirmed by the user; if `components` is omitted or empty, that means all 8 top-level sections, including the Scope/Constraints/Success Metrics subsections under Goals & Requirements) before dispatching.

❌ **Sending raw brain dump instead of structured decisions.** The worker expects markdown with the standard section headings. An unstructured text dump produces a poorly organized spec. **Fix:** structure the content with the required `##` headings before passing as `target.inline`.

❌ **Inlining a large, table-heavy decisions doc as a JSON string.** Embedding many `##` sections, tables, and code fences into a shell-assembled JSON string breaks the dispatch (escaping/heredoc failures). **Fix:** write the decisions to a tmp scaffold file **in your scratchpad / system temp dir (not inside the repo)** and pass its absolute path via `target.paths`.

❌ **Using this instead of `mma-audit subtype:spec`.** This writes a spec; audit verifies one. If you already have a spec and want it checked, use audit. **Fix:** dispatch `mma-audit subtype:spec` to verify an existing spec.

@include _shared/error-handling.md
