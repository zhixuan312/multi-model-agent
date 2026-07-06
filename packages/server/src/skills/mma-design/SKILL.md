---
name: mma-design
description: Use when the user has an idea, problem, or feature request that needs to be turned into a spec and plan — orchestrates the full interactive design workflow from brain dump through spec writing to plan generation
when_to_use: The user describes something they want to build, fix, or improve AND it needs structured design work before implementation. This is the front door to the MMA SDLC — from idea to spec to plan. If the user already has a spec → skip to mma-plan. If the user already has a plan → use mma-execute-plan.
version: "0.0.0-unreleased"
---

# mma-design

## Overview

Interactive design workflow that takes a raw idea and produces a formal spec + implementation plan. The main agent handles the judgment (dialogue, decisions, structuring); MMA workers handle the labor (investigation, spec writing, plan writing).

**Core principle — two question types, two resolution paths:**

- **Mechanical questions** (facts, patterns, signatures, prior art, what exists) → **resolve yourself** via mma-investigate, mma-research, mma-journal-recall. Never ask the user to look something up for you.
- **Decision questions** (tradeoffs, scope, priority, approach choices) → **ask the user** with concrete options, your recommendation, and reasoning. Never decide for the user.

## When to Use

**Use when:**
- The user has an idea, problem, or feature request
- The work needs structured design before implementation
- You want the full lifecycle: idea → spec → plan → (then execute)

**Don't use when:**
- The user already has a spec → `mma-plan`
- The user already has a plan → `mma-execute-plan`
- The task is small enough for `mma-delegate` (no spec/plan needed)
- The user just wants to explore/investigate → `mma-explore` or `mma-investigate`

## This is NOT an endpoint

`mma-design` is an orchestration skill — it teaches the main agent a workflow that dispatches other MMA skills/task types. There is no `POST /task { type: "design" }`.

## The Workflow (4 Phases)

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
Dispatch the accepted investigations in parallel. When results return, present findings to the user:
- What exists in the codebase (from investigate, if run)
- What approaches exist externally (from research, if run)
- What the project already decided (from journal-recall, if run)
- How these findings inform the design

If no investigations were run, proceed directly to Phase 2 using only the brain dump content. The main agent can still dispatch **targeted** investigations during Phase 2 to resolve specific mechanical questions — the Phase 1 batch is the upfront sweep, not the only opportunity.

### Phase 2: Structured interview — clarify, resolve, lock decisions

The brain dump gives the raw material. Your job is to turn it into concrete, unambiguous decisions by asking the right questions. You are an **interviewer**, not a form-filler.

**Step 1: Assess what's clear vs. ambiguous.**
Read the brain dump (and investigation results, if any). Map what the user said against the spec sections below. Mark each as:
- **Clear** — the brain dump already answers it. Don't re-ask. Confirm briefly and move on.
- **Ambiguous** — the user said something but it's vague, contradictory, or incomplete. Ask a focused question.
- **Missing** — the user didn't address it at all. Raise it.

**The spec sections (all must be filled before dispatch):**

1. Context/Background — who, what, why
2. Problem — one clear statement + business impact
3. Goals & Requirements — numbered goals + functional requirements
4. Scope — in/out explicitly enumerated
5. Constraints — compatibility, performance, data safety, timeline
6. Success Metrics — measurable targets
7. Alternatives — 2-3 approaches with tradeoffs
8. Decision Records — locked choices with rationale
9. Technical Design — current state → proposed architecture → interfaces
10. Testing Plan — layered strategy
11. Acceptance Criteria — numbered, testable

**Step 2: Ask focused questions for ambiguous/missing sections.**

Interview rules:

**For mechanical questions — resolve yourself:**
- If the brain dump says "use the existing interface" — investigate and fill in the name, signature, file path. Don't ask the user.
- If you need to know the tech stack, test framework, import style — read the codebase. Don't ask.
- If you need prior art or external approaches — research. Don't ask.
- If you need what the project already decided — recall from journal. Don't ask.

**For decision questions — ask the user:**
- One question at a time. Don't dump 5 questions in one message.
- Multiple choice when possible. "Should we (A) throw on zero or (B) return NaN?" beats "how should we handle zero?"
- Always include your recommendation with reasoning. The user picks.
- Surface contradictions. "You said no breaking changes, but the proposed rename IS breaking — which takes priority?"

**General:**
- Confirm clear sections briefly. "Brain dump covers Context, Problem, Goals — carrying forward. Let me ask about Scope..."
- Skip sections the user already locked. "Option A because X" = confirmed decision. Don't re-debate.

**Step 3: Lock each decision.**
As the user answers each question, record the confirmed decision.

**Step 4: Present the decision summary.**
When all sections are filled, present the complete set of confirmed decisions to the user as a numbered list — one line per section. This is the last checkpoint before formal spec writing. The user may revise any decision, add constraints, or adjust scope. Only proceed to Phase 3 when the user confirms the summary.

### Phase 3: Write Spec (dispatch to mma-spec)

Once all sections are confirmed:

1. Gather all confirmed sections into a structured markdown document with `##` headings for: Context, Problem, Goals & Requirements (with Scope/Constraints/Success Metrics as `###` subsections), Alternatives, Decision Records, Technical Design, Testing Plan, Acceptance Criteria
2. Dispatch:
   ```json
   { "type": "spec", "prompt": "<feature title>", "target": { "inline": "<structured decisions markdown>" } }
   ```
3. Poll `GET /task/:taskId` until terminal. The `output.summary` contains `{ specPath, sections, acceptanceCriteriaCount, notes }` — `specPath` is the written spec file path
4. Read the spec file and present a summary to the user for review
5. If the user requests changes: small edits (wording, constraints, scope tweaks) → edit the file directly. Large structural changes → re-dispatch to mma-spec with updated decisions.

### Phase 4: Write Plan (dispatch to mma-plan)

After the user approves the spec. The user may want to audit the spec first (`mma-audit subtype:spec`) — that's their call, not built into this workflow. When the user is ready for the plan:

1. Dispatch:
   ```json
   { "type": "plan", "prompt": "<goal description>", "target": { "paths": ["<spec file path>"] } }
   ```
2. Poll `GET /task/:taskId` until terminal. The `output.summary` contains `{ planPath, taskCount, tasks: [{title, verdict}], notes }` — check `verdict` per task: `executable` (ready), `partial` (review first), `blocked` (fix plan)
3. Present the resulting plan to the user
4. The plan is ready for `mma-execute-plan`

## What this skill does NOT include

- **Built-in audit loops.** If the user wants to audit the spec or plan, they dispatch `mma-audit subtype:spec` or `mma-audit subtype:plan` separately.
- **Automatic execution.** The skill produces a spec and plan. Execution (`mma-execute-plan`) is the user's next step.
- **Design decisions by the agent.** The main agent presents, proposes, and recommends — but never selects without user confirmation.

## Anti-patterns

❌ **Skipping the investigation OFFER.** Always propose the three investigations after the brain dump — the user may accept all, some, or none. If the user skips all, that's fine (the brain dump has the decisions). But skipping the offer means the user never got the chance to ground the design. **Fix:** always propose; respect the user's choice.

❌ **Deciding for the user.** "I'll go with Option A since it's simpler" — NO. Present all options, recommend one with reasoning, and wait for the user to pick.

❌ **Marching through all 11 sections mechanically.** If the brain dump already covers 8 sections, don't re-ask them. Focus the dialogue on what's ambiguous or missing. Confirm the clear ones briefly and move on.

❌ **Dispatching investigations without consent.** Always propose the three investigations and wait for user agreement before dispatching.

❌ **Writing the spec inline instead of dispatching mma-spec.** The main agent gathers and structures decisions. The worker writes the formal document. Don't burn flagship tokens on formatting labor.
