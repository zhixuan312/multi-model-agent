---
name: mma-design
description: Use when the user wants to build, change, or rethink something non-trivial — a new feature, a redesign, a refactor, a new project, or a fix to a systemic problem. Orchestrates the interactive design workflow (brain dump → investigation → structured decisions → written spec). Entry point for any work that should be designed before coded.
when_to_use: >-
  The user expresses intent to build, change, fix, redesign, refactor, or rethink something —
  and the scope is large enough that jumping straight to code would be reckless (roughly: touches
  3+ files, crosses module boundaries, or involves design choices). Trigger signals: "I want to
  build/add X", "let's do X", "we need to rethink/redesign/refactor X", "X is broken/slow/wrong
  and needs a proper fix", "how should we approach X" (when X is a project, not a codebase
  question), "I have an idea", brain dumps, feature requests, problem statements, wishlists.
  Also triggers when the user says "let's design" or "let's spec out" explicitly. Does NOT
  trigger for: quick single-file fixes or renames (→ mma-delegate), codebase questions like
  "how does X work" (→ mma-investigate), pure exploration "what are our options" without build
  intent (→ mma-explore), work where a spec already exists on disk (→ mma-plan), or work where
  a plan already exists (→ mma-execute-plan).
version: "0.0.0-unreleased"
---

# mma-design

## Overview

Interactive design workflow that takes a raw idea and produces a formal spec. The main agent handles the judgment (dialogue, decisions, structuring); MMA workers handle the labor (investigation, spec writing).

**Core principle — two question types, two resolution paths:**

- **Mechanical questions** (facts, patterns, signatures, prior art, what exists) → **resolve yourself** via mma-investigate, mma-research, mma-journal-recall. Never ask the user to look something up for you.
- **Decision questions** (tradeoffs, scope, priority, approach choices) → **ask the user** with concrete options, your recommendation, and reasoning. Never decide for the user.

## When to Use

**Use when:**
- The user has an idea, problem, or feature request
- The work needs structured design before implementation
- You want to go from idea to a written spec

**Don't use when:**
- The user already has a spec → `mma-plan`
- The user already has a plan → `mma-execute-plan`
- The task is small enough for `mma-delegate` (no spec/plan needed)
- The user just wants to explore/investigate → `mma-explore` or `mma-investigate`

## This is NOT an endpoint

`mma-design` is an orchestration skill — it teaches the main agent a workflow that dispatches other MMA skills/task types. There is no `POST /task { type: "design" }`.

## The Workflow (3 Phases)

### Phase 1: Discover

**Step 1: Capture the brain dump.**
Let the user describe their idea, problem, or request. Don't interrupt — capture everything.

**Step 2: Propose investigations (optional — user can skip).**
After the brain dump, propose running up to three parallel investigations:

> "To ground this design in what exists, I can run:
> 1. **mma-investigate** — what exists in the codebase today that relates to this
> 2. **mma-research** — what's been done externally (prior art, approaches, libraries)
> 3. **mma-journal-recall** — what this project already decided or learned about related topics
>
> Want me to run any or all of these? Or skip straight to structuring the spec?"

The user may:
- **Accept all three** — dispatch in parallel, synthesize results, then proceed to Phase 2.
- **Accept some** — dispatch only the accepted ones. Skip the rest.
- **Skip all** — proceed directly to Phase 2. The brain dump already contains the decisions; investigations are enrichment, not prerequisites.

**Step 3: Dispatch and synthesize (if any investigations accepted).**
Dispatch the accepted investigations via HTTP `POST /task` to the MMA server — **never as inline Agent dispatches** (those burn flagship-model tokens on read-only labor). Use parallel Bash tool calls, one per accepted leg:

- `mma-investigate` → `POST /task?cwd=<project-root>` with `{ "type": "investigate", "prompt": "<codebase question>" }`
- `mma-research` → `POST /task?cwd=<project-root>` with `{ "type": "research", "prompt": "<external question>" }`
- `mma-journal-recall` → `POST /task?cwd=<workspace-root>` with `{ "type": "journal_recall", "prompt": "<what has the project decided about X>" }`

Poll each `GET /task/:taskId` until terminal. When all results return, present findings to the user:
- What exists in the codebase (from investigate, if run)
- What approaches exist externally (from research, if run)
- What the project already decided (from journal-recall, if run)
- How these findings inform the design

If no investigations were run, proceed directly to Phase 2 using only the brain dump content. The main agent can still dispatch **targeted** investigations during Phase 2 to resolve specific mechanical questions via `POST /task` — the Phase 1 batch is the upfront sweep, not the only opportunity.

## Phase 2: Structured interview — clarify, resolve, lock decisions

The default scope is all eight canonical components. Narrow only when the user's initial brain dump shows explicit subset intent:
- the brain dump names specific components, or
- the brain dump unambiguously says it wants only some components.

If the user expresses subset intent without naming the exact components, ask exactly one clarifying question to obtain the explicit component list before narrowing. If it is uncertain whether the brain dump expresses explicit subset intent, treat it as no subset intent and continue with all eight components. Never narrow on a borderline or inferred signal.

This workflow will default to all eight components unless the user shows explicit subset intent.
The design workflow never narrows on a borderline or inferred signal.

**The 8 spec components (unified MMA/Forge standard):**

1. **Context** — background: who, what, why
2. **Problem** — one clear problem statement + business impact
3. **Goals & Requirements** — numbered goals, functional requirements, scope (in/out), constraints, success metrics
4. **Alternatives** — driving factors, 2-3 options with tradeoffs, comparison + decision records with rationale
5. **Technical Design** — current state → proposed architecture → interfaces → impact
6. **Testing Plan** — layered test strategy
7. **Risks & Mitigations** — risk table + mitigation plan, failure handling
8. **User Stories & Tasks** — user stories with acceptance criteria (numbered AC-N.N, testable)

**For mechanical questions — resolve yourself via MMA workers (HTTP `POST /task`):**
- Never use inline Agent dispatches for these — always use HTTP `POST /task` to the MMA server. Workers cost ~10x less and don't pollute main context.
- If the brain dump says "use the existing interface" — dispatch `type: "investigate"` to fill in the name, signature, file path. Don't ask the user.
- If you need to know the tech stack, test framework, import style — dispatch `type: "investigate"`. Don't ask.
- If you need prior art or external approaches — dispatch `type: "research"`. Don't ask.
- If you need what the project already decided — dispatch `type: "journal_recall"`. Don't ask.

## Phase 3: Dispatch spec (terminal step)

When assembling the structured markdown and dispatch body:
- If there is no explicit subset intent, interview and dispatch all eight components.
- If explicit subset intent exists and the exact list is known, interview only those components and dispatch `mma-spec` with `"components": ["<canonical labels>"]`.
- Preserve canonical component order in the dispatched `components` array, regardless of the order the user named them.

**What comes next is the user's decision** — not part of this skill:
- Review the spec → read the file
- Audit the spec → `mma-audit subtype:spec`
- Write a plan → `mma-plan`
- Execute the plan → `mma-execute-plan`

## What this skill does NOT include

- **Plan writing.** This skill ends at the spec. Plan writing is a separate step via `mma-plan`.
- **Audit loops.** Spec auditing is a separate step via `mma-audit subtype:spec`.
- **Execution.** Plan execution is a separate step via `mma-execute-plan`.
- **Design decisions by the agent.** The main agent presents, proposes, and recommends — but never selects without user confirmation.

## Anti-patterns

❌ **Skipping the investigation OFFER.** Always propose the three investigations after the brain dump — the user may accept all, some, or none. If the user skips all, that's fine (the brain dump has the decisions). But skipping the offer means the user never got the chance to ground the design. **Fix:** always propose; respect the user's choice.

❌ **Deciding for the user.** "I'll go with Option A since it's simpler" — NO. Present all options, recommend one with reasoning, and wait for the user to pick.

❌ **Marching through all 8 components mechanically.** If the brain dump already covers most components, don't re-ask them. Focus the dialogue on what's ambiguous or missing. Confirm the clear ones briefly and move on.

❌ **Dispatching investigations without consent.** Always propose the three investigations and wait for user agreement before dispatching.

❌ **Writing the spec inline.** The main agent gathers and structures decisions. The worker writes the formal document via `mma-spec`. Don't burn flagship tokens on formatting labor.

❌ **Continuing past spec dispatch.** mma-design ends when the spec is written. Plan writing, auditing, and execution are separate skills the user invokes next.
