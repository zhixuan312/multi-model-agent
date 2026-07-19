---
name: mma-brainstorm
description: Use when a grounded idea needs to be grilled into a formal spec — runs a relentless one-decision-at-a-time requirement interview, resolving mechanical questions via workers and putting only real decisions to the user, then dispatches mma-spec. Not for grounding a raw idea (use mma-explore first) or for work where a spec already exists (use mma-plan).
when_to_use: >-
  The user has an idea, problem, or feature request that is grounded enough to design — either they
  already know what they want, or mma-explore has produced an exploration.md. You want to interview
  the requirements into confirmed, unambiguous decisions and then write a formal spec. Trigger
  signals: "let's design/spec this", "grill me on X", "turn this into a spec", a confirmed
  exploration ready to narrow, a feature request with enough shape to interview. Does NOT trigger
  for: grounding a raw braindump ("what are our options", "I have an idea") → mma-explore; a spec
  already on disk → mma-plan; a plan already on disk → mma-execute-plan; a quick single-file fix →
  mma-delegate; a codebase question → mma-investigate. The natural next step after brainstorm is
  mma-spec (offered, not forced).
version: "0.0.0-unreleased"
---

# mma-brainstorm

## Overview

A relentless requirement interview that takes a grounded idea and grills it into confirmed
decisions, then dispatches `mma-spec` to write the formal document. The main agent handles the
judgment (dialogue, decisions, structuring); MMA workers handle the labor (investigation, spec
writing).

**Core discipline — "plan, don't do":**

- **Name the destination first.** Before any question, state in one or two lines what success looks
  like — the spec you're aiming at. This fixes the scope every later question is measured against.
- **Grill one decision at a time.** Never dump five questions in one message. Each exchange resolves
  exactly one open decision; record the answer before moving to the next.
- **Never self-answer a human decision.** A tradeoff, scope, or priority choice is the user's — you
  present options and a recommendation, you do not decide.
- **Stop when the way is clear.** The interview is done when nothing is left to decide before someone
  could go and write the spec — not before, not after.

**Two question types, two resolution paths:**

- **Mechanical questions** (facts, patterns, signatures, prior art, what exists) → **resolve
  yourself** via `mma-investigate`, `mma-research`, `mma-journal-recall`. Never ask the user to look
  something up for you.
- **Decision questions** (tradeoffs, scope, priority, approach choices) → **ask the user** with
  concrete options, your recommendation, and reasoning. Never decide for the user.

## When to Use

**Use when:**
- The idea is grounded (the user knows what they want, or an `exploration.md` exists) and needs to
  become a formal spec.
- You want structured, confirmed requirements before any code is written.

**Don't use when:**
- The idea is still a raw braindump needing grounding → `mma-explore` (run it first; its
  `exploration.md` is this skill's ideal input).
- A spec already exists on disk → `mma-plan`.
- A plan already exists → `mma-execute-plan`.
- The task is small enough for `mma-delegate` (no spec/plan needed).
- It's a codebase question → `mma-investigate`.

## This is NOT an endpoint

`mma-brainstorm` is a main-agent orchestration skill — it teaches the main agent a workflow that
dispatches other MMA task types. There is no `POST /task { type: "brainstorm" }`. The mechanical
sub-questions it resolves ARE dispatched (to `investigate` / `research` / `journal_recall`), and its
terminal step dispatches `mma-spec`.

## Inputs

- **An `exploration.md`** (from `mma-explore`, usually under `.mma/explorations/`), when present —
  read it first. Its `## Background`, `## Current State`, and `## Rough Direction` sections seed the
  destination and pre-answer several components; the ranked directions map directly onto the spec's
  `Alternatives` component. Do not re-ask what the exploration already settled.
- **A raw idea/braindump**, when the user skips explore — the interview still works, you just start
  colder and lean harder on mechanical-question workers to ground it as you go.

## The workflow

### Phase 0: Name the destination

State the destination in one or two lines and get the user's nod:

> "Destination: a spec for a token-refresh subsystem that rotates OAuth credentials before expiry,
> with no user-visible re-auth. That the target? Anything to add or cut before I start grilling?"

If the user has no clear destination yet, that's a signal the idea isn't grounded — suggest
`mma-explore` first rather than interviewing into fog.

### Phase 1: Assess clear vs ambiguous vs missing

Map what you already know (from the braindump, and the `exploration.md` if present) against the 8
spec components below. Mark each:

- **Clear** — already answered. Confirm briefly, don't re-ask.
- **Ambiguous** — said, but vague / contradictory / incomplete. Queue a focused question.
- **Missing** — not addressed. Queue it.

**The 8 spec components (the canonical spec standard):**

1. **Context** — background: who, what, why
2. **Problem** — one clear problem statement + business impact
3. **Goals & Requirements** — numbered goals, functional requirements, scope (in/out), constraints, success metrics
4. **Alternatives** — driving factors, 2-3 options with tradeoffs, comparison + decision records with rationale
5. **Technical Design** — current state → proposed architecture → interfaces → impact
6. **Testing Plan** — layered test strategy
7. **Risks & Mitigations** — risk table + mitigation plan, failure handling
8. **User Stories & Tasks** — user stories with acceptance criteria (numbered AC-N.N, testable)

### Phase 2: Grill — one decision at a time

Work the queue. For each open item:

**Mechanical questions — resolve yourself via workers (HTTP `POST /task`), never inline Agent dispatches:**
- Never use inline Agent dispatches for these — always use HTTP `POST /task` to the MMA server.
  Workers cost ~10× less and don't pollute main context.
- If the braindump says "use the existing interface" — dispatch `POST /task` with
  `{ "type": "investigate" }` to fill in the name, signature, file path. Don't ask the user.
- If you need the tech stack, test framework, or import style — dispatch `{ "type": "investigate" }`.
- If you need prior art or external approaches — dispatch `{ "type": "research" }`.
- If you need what the project already decided — dispatch `{ "type": "journal_recall" }`.

**Decision questions — ask the user, one at a time:**
- One question per message. Never dump the whole queue.
- Multiple choice when possible: "Should we (A) throw on zero or (B) return NaN?" beats an
  open-ended "how should we handle zero?"
- Always include your recommendation with reasoning. The user picks.
- Surface contradictions the moment you spot one: "You said no breaking changes, but the proposed
  rename IS breaking — which takes priority?"

**Record each answer before moving on.** As the user resolves a decision, lock it. Keep a running
glossary of the domain terms and a short decision log (the rationale, not just the choice) as you
go — these become the spec's `Alternatives` decision records and its `Context` vocabulary.

### Phase 3: Confirm the decision summary

When every component is clear, present the complete set of confirmed decisions as a numbered list —
one line per component. This is the last checkpoint before the spec is written. The user may revise
any decision, add a constraint, or adjust scope. Only proceed once the user confirms.

### Phase 4: Dispatch mma-spec (soft-suggested terminal step)

Gather the confirmed decisions into structured markdown (the 8 `##` component headings; `###` for
sub-sections) and hand off to `mma-spec`. **Offer, don't force** — brainstorm ends at confirmed
decisions and a soft suggestion:

> "Decisions locked. Natural next step: `mma-spec` to write the formal spec (optional). Dispatch it
> now?"

On the user's go (in `/mma-flow`, the flow drives this at stage `D3` directly):

1. Write the confirmed decisions markdown to a **throwaway scaffold file in your scratchpad** (an absolute path under the system temp / scratchpad dir — **never inside the repo**).
2. Dispatch `mma-spec` with `target.paths = [<decisions-scaffold>, <exploration.md>]` — the **decisions file first** (authoritative, what the worker expands) and the **exploration.md second** (grounding the worker reads for context but never treats as decisions). If no `exploration.md` exists (the user skipped explore), pass just `[<decisions-scaffold>]`. The `prompt` is the feature title; add `components` for a subset.
3. Delete the scaffold once `specPath` returns.

## Component scope (default all eight; narrow only on explicit subset intent)

The default scope is **all eight** canonical components. Narrow only when the user shows explicit
subset intent:
- the user names specific components, or
- the user unambiguously says they want only some components.

If the user expresses subset intent without naming the exact components,
ask exactly one clarifying question to obtain the explicit component list before narrowing. If it is
uncertain whether the input expresses explicit subset intent, treat it as no subset intent and
default to all eight components. The interview never narrows on a borderline or inferred signal.

When assembling the `mma-spec` dispatch:
- No explicit subset intent → interview and dispatch all eight components.
- Explicit subset intent with a known list → interview only those and dispatch `mma-spec` with
  `"components": ["<canonical labels>"]`, preserving canonical component order regardless of the
  order the user named them.

## What this skill does NOT include

- **Grounding a raw idea.** That's `mma-explore` — run it first when the idea isn't grounded.
- **Spec writing.** The worker writes the formal document via `mma-spec`; brainstorm gathers and
  structures the decisions.
- **Plan writing / audit loops / execution.** Separate steps (`mma-plan`, `mma-audit`,
  `mma-execute-plan`) the user invokes next.
- **Design decisions by the agent.** The main agent presents, proposes, recommends — never selects
  a human decision without user confirmation.

## Anti-patterns

❌ **Dumping the whole question queue at once.** Grill one decision per message; record before the
next. **Fix:** single-question exchanges.

❌ **Deciding for the user.** "I'll go with Option A since it's simpler" — NO. Present all options,
recommend one with reasoning, wait for the user to pick.

❌ **Re-asking what the exploration or braindump already settled.** Focus the interview on the
ambiguous and missing components; confirm the clear ones briefly and move on.

❌ **Asking the user a mechanical question.** Signatures, file paths, prior art, tech stack — resolve
via `mma-investigate` / `mma-research` / `mma-journal-recall`, never by asking the user to look it up.

❌ **Interviewing into fog.** If the destination can't be named, the idea isn't grounded. **Fix:**
suggest `mma-explore` first.

❌ **Auto-dispatching mma-spec.** Brainstorm ends at confirmed decisions + a soft offer. The spec
dispatch is the user's go (or `/mma-flow` stage `D3`).

## Multi-repo mode (parent-aware)

When `/mma-flow` has entered multi-repo mode with a confirmed **involved repo** set, brainstorm preserves
that set and treats the **parent workspace** as the durable artifact root when it dispatches `mma-spec`.
Single-project mode is unchanged.
