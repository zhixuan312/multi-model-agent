---
name: mma-explore
description: Use when a raw idea or problem needs grounding before it's designed — captures a braindump, fans out divergent internal-codebase investigation + external research + prior-learnings recall in parallel, then synthesises the results into a written exploration.md (Background · Current State · Rough Direction). Not for "where is X" single-answer questions (use mma-investigate).
when_to_use: >-
  The user has a raw idea, problem, feature request, or braindump and you want to ground it in
  reality before brainstorming or planning. The question is exploratory ("what are our options",
  "what approaches exist", "how should we approach X", "I have an idea", a wishlist, a problem
  statement). The skill captures the braindump, proposes a divergent fan-out of mma-investigate
  (internal), mma-research (external), and mma-journal-recall (prior learnings), dispatches them in
  parallel after a lightweight user check, then synthesises the results into a written
  exploration.md. DO NOT use for convergent single-answer codebase questions — those are
  mma-investigate. The natural next step after explore is mma-brainstorm (optional).
version: "0.0.0-unreleased"
---

# mma-explore

## Overview

Turn a raw braindump into a grounded, written **exploration.md**. The user dumps everything they
know; you fan that brief out into parallel delegated tasks across three types — `mma-investigate`
(internal codebase), `mma-research` (external sources), and `mma-journal-recall` (what this project
already learned/decided, from the `.mma/journal/` graph) — and **you** synthesise their results
into one artifact on disk. The number of tasks under each type is sized to the braindump (see
Phase 2), not fixed at one-per-type.

**Core principle:** Exploration is divergent (survey, enumerate, compare). The delegated tasks are
labor — delegate them. The synthesis is your judgment work and stays in main context. The journal
type is what keeps you from re-proposing a direction the project already tried and dropped — it
grounds the scan in your own history, not just the code and the outside world.

The flow is: braindump → a user-checked parallel fan-out → a synthesised `exploration.md`
(Background · Current State · Rough Direction). The user gate is deliberately terse (see Phase 2)
— you serve power users who already know what they want.

## When to Use

**Use when:**
- The user has an idea, problem, or feature request and you want to ground it before designing.
- The question is exploratory — multiple directions to weigh, not one fact to look up.

**Don't use when:**
- You want ONE synthesised answer with citations → `mma-investigate` (don't continue here).
- A single web fetch is all you need → `WebFetch` inline.
- The idea is already grounded and you want to grill it into a spec → `mma-brainstorm`.
- A spec already exists on disk → `mma-plan`.

## This is NOT an endpoint

`mma-explore` is a main-agent orchestration skill — there is no `POST /task { type: "explore" }`.
Behind the scenes you dispatch the three delegated tools yourself: `mma-investigate`
(`POST /task` with `type: "investigate"`), `mma-research` (`type: "research"`), and
`mma-journal-recall` (`type: "journal_recall"`).

## The workflow (4 phases)

### Phase 1: Capture the braindump

Let the user describe their idea, problem, or request. Don't interrupt — capture everything. The
braindump is the raw material for the fan-out and for the exploration's `## Background`.

### Phase 2: Propose the fan-out — a lightweight user check

Read the braindump and **size the fan-out to what it actually contains** — the count under each
type is driven by the number of distinct questions, **never a fixed one-per-type**. `investigate`
is the dominant type; `research` and `recall` are usually lighter. Reasonable ranges:

- **`investigate` — 1–8**, one task per distinct **repo, module, or subsystem** the idea touches.
  Most ideas land at 2–5; a broad cross-cutting one reaches ~8. This is the bulk of the fan-out.
- **`research` — 0–3**, one task per distinct **external question**. Use **0** when the work is
  purely internal (a refactor with no prior-art question); 1–2 is typical when external practice matters.
- **`journal_recall` — 0–3**, one task per distinct **prior-decision topic**. Use **0** for a
  greenfield / empty journal or a trivial change; 1–2 is typical on a mature project.

So the shape tracks the idea's size: a **typical** feature is ~**5-1-1**, a **large** cross-cutting
one ~**8-2-2**, a **minor** one ~**2-0-1** (total ≈ 3–12 parallel tasks). Name each task by the
specific question it answers — that specificity is what makes the parallel workers produce sharp,
non-overlapping findings. Then present the plan as a **one-glance summary** and ask if the user wants
to add anything — **not** a per-task editor:

> "Planning the fan-out: **5 investigations** (auth module · token store · session layer · API
> surface · migration path), **1 research** (OAuth refresh prior art), **1 recall** (what we decided
> about token expiry). Anything you'd add before I dispatch?"

This gate is kept terse on purpose — these callers are power users who know exactly what they want.
The user may append tasks or just say go. Do **not** walk the user through each task one by one. Do
not ask which of internal/external/prior-learnings to run — explore always runs all three types
unless a type is genuinely inapplicable (see How to run).

### Phase 3: Dispatch the three legs in parallel — in ONE message

Dispatch **every** task from the Phase 2 plan (all N + M + K, plus any user additions) in ONE
message (parallel tool use) — not one call per type, one call per question:

1. `mma-investigate` (1–8) — internal codebase research, **one dispatch per distinct repo/area/subsystem**.
   - You MAY skip this type entirely only if the idea is unambiguously greenfield (no codebase
     touch-points exist). When in doubt, run it.
2. `mma-research` (0–3) — external multi-source research, **one dispatch per distinct external question**.
   Zero is fine when nothing external applies.
3. `mma-journal-recall` (0–3) — prior learnings/decisions, **one dispatch per distinct prior-decision topic**.
   - Run it whenever the project plausibly has relevant history — a superseded prior decision is
     exactly the signal you most want before design. Zero is legitimate only for a greenfield / empty
     journal or a trivial change. When run and nothing comes back, that's the `(no prior learning)`
     sentinel, not an error.

The three legs are **types**, not a cap on task count — a single explore issues however many
dispatches the braindump warrants (≈ 3–12 total, weighted toward `investigate`).

Wait for all legs to return before synthesising. Do NOT proceed until you have every result (or
have decided to skip investigate as greenfield).

Example (one message, parallel tool use — note multiple tasks under one type):

```
[parallel tool use]
  mma-investigate    { prompt: "How does the streaming JSON parser handle backpressure?", target: { paths: ["src/parsers/"] } }
  mma-investigate    { prompt: "How is the parser's output buffer sized and flushed?", target: { paths: ["src/buffers/"] } }
  mma-research       { prompt: "State-of-the-art SIMD JSON parsers with backpressure?" }
  mma-research       { prompt: "Prior art on adaptive buffer sizing for streaming parsers?" }
  mma-journal-recall { prompt: "what have we learned about streaming-parser backpressure tradeoffs?" }
  mma-journal-recall { prompt: "did we decide anything about buffer-size defaults before?" }
```

### Phase 4: Synthesise and write `exploration.md`

Synthesis is your judgment work — do it in main context, then write the artifact to disk yourself
(it's short: one page, three top-level sections). Do NOT dump the raw leg reports back to the user;
the synthesis IS the output.

**Where:** `.mma/explorations/YYYY-MM-DD-<slug>.md` (co-located with `.mma/specs`, `.mma/plans`,
`.mma/journal`). Derive `<slug>` from the exploration title: lowercase, non-alphanumeric runs → `-`,
collapse repeats, trim, truncate to 40 chars, fall back to `exploration` if empty. Use today's date.

After writing, print the path and **soft-suggest** the next step — never force it:

> "Wrote the exploration to `.mma/explorations/2026-07-12-<slug>.md`. Natural next step:
> `mma-brainstorm` to grill this into a spec (optional)."

## exploration.md structure (the artifact)

Top-level headers are `##` and follow the canonical exploration.md format (`Background` ·
`Current State` · `Rough Direction`). Keep the top level at `##` — downstream tools parse these
sections by their `##` heading, so a deeper top level makes them see zero sections.

```markdown
# Exploration: <title>

## Background
The braindump distilled — who / what / why, the intent and problem framing.
(← Phase 1 braindump; your words, not the user's verbatim.)

## Current State
What exists today, synthesised. Anchored in the internal leg plus any prior-learning that describes
what the project already built or tried.

### Findings — Internal (codebase)
From mma-investigate. Each: a claim + a `file:LINE` citation pulled from the finding's evidence.

### Findings — External (prior art)
From mma-research. Each: a claim + a source name / URL.

### Findings — Prior learnings (journal)
From mma-journal-recall. Each: a claim + a journal node id (e.g. `node 0012`). If a cited node is
**superseded**, say so inline (`node 0012 [superseded by 0013] — …`) so the "we already moved past
this" signal survives. Use `(no prior learning)` when the leg returned nothing.

## Rough Direction
3–5 ranked candidate directions — alternatives-style, the same shape as the spec's `Alternatives`
component, so a downstream spec can lift them almost verbatim. Each direction:

- **Title** + one-paragraph summary.
- **Key tradeoff** — what you give up to get its upside.
- **Backing citations** — at least one internal, external, or prior-learning cite (or the matching
  sentinel: `(no internal anchor — fully greenfield)`, `(no external source found)`,
  `(no prior learning)`).
- **Divergence axis** — one line on what makes this direction different from the others. No two
  directions may share the same axis.
- If a superseded/dropped journal node maps onto a direction, keep it but mark it
  `⚠ already explored — see node NNNN` and weight it down.

### Recommended next step
One paragraph naming which direction to pursue first and why. If a prior learning rules a direction
in or out, cite it here. Close by soft-suggesting `mma-brainstorm`.
```

## Reading the leg results

All three legs return the standard response envelope. The authoritative citation source is
**`output.summary.findings`** — each finding has `weight`, `category`, `claim`, `evidence`, plus
route-specific fields (investigate: `file`, `line`; research: `url`, `source`; recall: `nodeId`,
`nodePath`). Findings live INSIDE `output.summary` (the parsed refiner JSON), NOT at
`output.findings` (which does not exist).

| Check | How |
|---|---|
| Did the leg succeed? | `error` is `null` — findings may be zero on a read route; finding nothing is a valid completion |
| Internal citation | `output.summary.findings[i].claim` + a `file:LINE` token from its `evidence` |
| External citation | `output.summary.findings[i].claim` + a source name / URL from its `evidence` |
| Prior-learning citation | `output.summary.findings[i].claim` + a journal node id from its `evidence`; watch for **superseded** status |
| Divergence axis | `output.summary.findings[i].category` groups findings — pick across categories so directions don't collapse onto one axis |

Apply a sentinel only when `output.summary.findings` is empty AND `output.summary` carries no
finding-level content. Do NOT apply a sentinel just because a summary reads tersely.

## Best practices

Use this at the top of the design funnel: **explore (ground) → brainstorm (grill) → spec (write)**.
Explore's `exploration.md` is the grounding input `mma-brainstorm` consumes. In `/mma-flow`, explore
is stage `D1`.

## Common pitfalls

❌ **Dumping the raw leg reports back to the user.** The synthesised exploration.md IS the output;
the raw reports are inputs you reason over. **Fix:** synthesise into the three sections with
citations (or sentinels).

❌ **Turning the Phase 2 gate into a per-task editor.** The CLI check is a one-glance summary +
"anything to add?" — not a walk-through. **Fix:** summarise counts + purpose, ask once, dispatch.

❌ **Skipping `mma-investigate` for convenience.** "Greenfield" must be unambiguous. When in doubt,
run it.

❌ **Skipping `mma-journal-recall` to save a call.** A superseded prior decision is the single most
valuable signal before design. Always run it; handle empty with `(no prior learning)`.

❌ **Inventing citations.** Every citation traces to a leg finding or to a sentinel. Never fabricate.

❌ **Padding to hit 5 directions.** One direction with high-confidence citations beats five watery
ones. Stop at the natural number of distinct directions in the data.

❌ **Auto-running mma-brainstorm.** Explore ends at the written file + a soft suggestion. Chaining is
the user's call (or `/mma-flow`'s).

## Failure handling

| Scenario | What to do |
|---|---|
| `mma-research` failed | Use `(no external source found)` on every external line. If `mma-investigate` also failed, do NOT write the artifact — surface both errors. |
| `mma-investigate` failed | Treat as greenfield — use `(no internal anchor — fully greenfield)`. |
| `mma-journal-recall` failed OR returned 0 findings | Use `(no prior learning)` and continue — the journal leg is additive, never blocking. |
| All three failed | Report all errors. Do NOT fabricate an exploration.md. |
| Both investigate and research failed | Report both errors. Do NOT write the artifact. |
| Investigate returned `needsCallerClarification: true` | Pause — surface the clarification need. Do NOT synthesise over an unfinished investigation. |
| Research returned 0 usable sources | Sentinel on external lines; add a one-line note under `## Current State` that external research returned nothing usable. |
| Investigate headline reads "0 citations" but `output.summary.findings.length > 0` | Known stage-sync noise — IGNORE the headline; read `output.summary.findings` directly. |
