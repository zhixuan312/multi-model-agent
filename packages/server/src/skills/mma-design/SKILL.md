---
name: mma-design
description: Use when the user has an idea, problem, or feature request that needs to be turned into a spec and plan — orchestrates the full interactive design workflow from brain dump through spec writing to plan generation
when_to_use: The user describes something they want to build, fix, or improve AND it needs structured design work before implementation. This is the front door to the MMA SDLC — from idea to spec to plan. If the user already has a spec → skip to mma-plan. If the user already has a plan → use mma-execute-plan.
version: "0.0.0-unreleased"
---

# mma-design

## Overview

Interactive design workflow that takes a raw idea and produces a formal spec + implementation plan. The main agent handles the judgment (dialogue, decisions, structuring); MMA workers handle the labor (investigation, spec writing, plan writing).

**Core principle:** The engineer makes every design decision. The main agent presents information and options; the engineer confirms or redirects. The main agent never selects a substantive design option without explicit user confirmation. MMA workers write the formal documents from confirmed decisions.

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

**Step 2: Propose investigations.**
After the brain dump, propose running three parallel investigations and explain what each brings:

> "To ground this design in what exists, I'd like to run three investigations:
> 1. **mma-investigate** — what exists in the codebase today that relates to this
> 2. **mma-research** — what's been done externally (prior art, approaches, libraries)
> 3. **mma-journal-recall** — what this project already decided or learned about related topics
>
> Shall I run these?"

**Wait for user agreement.** Do NOT dispatch investigations without user consent.

**Step 3: Dispatch and synthesize.**
Once the user agrees, dispatch all three in parallel:
- `mma-investigate` with a focused question about the codebase
- `mma-research` with the external research question
- `mma-journal-recall` with a recall query about related decisions/learnings

When results return, synthesize the findings and present to the user:
- What exists in the codebase today (from investigate)
- What approaches exist externally (from research)
- What the project already decided (from journal-recall)
- How these findings inform the design

### Phase 2: Design (interactive — one section at a time)

Structure the idea into spec sections. Present each section to the user, propose options where relevant, and let the user confirm or redirect before moving on.

**The sections (in order):**

1. **Context/Background** — who, what, why
2. **Problem** — one clear statement + business impact
3. **Goals & Requirements** — numbered goals + functional requirements (must/should/may)
4. **Scope** — in/out explicitly enumerated
5. **Constraints** — compatibility, performance, data safety, timeline
6. **Success Metrics** — measurable table (metric | target | how measured)
7. **Alternatives** — 2-3 approaches with driving factors + comparison matrix. Present all options with your recommendation and reasoning. **The user picks — you do not.**
8. **Decision Records** — lock in choices with rationale
9. **Technical Design** — current state → proposed architecture → interfaces → data model
10. **Testing Plan** — layered strategy (unit/integration/E2E)
11. **Acceptance Criteria** — numbered AC-X.X with checkboxes

**Rules for this phase:**
- One section per message. Do not overwhelm with multiple sections.
- Present information and propose structure. Do not decide.
- When alternatives exist, present all with a recommendation and reasoning. The user picks.
- If the user redirects, incorporate their feedback and re-present the section.
- Every substantive design choice must be explicitly confirmed by the user.

### Phase 3: Write Spec (dispatch to mma-spec)

Once all sections are confirmed:

1. Gather all confirmed sections into a structured markdown document with `##` headings for: Context, Problem, Goals & Requirements (with Scope/Constraints/Success Metrics as `###` subsections), Alternatives, Decision Records, Technical Design, Testing Plan, Acceptance Criteria
2. Dispatch:
   ```json
   { "type": "spec", "prompt": "<feature title>", "target": { "inline": "<structured decisions markdown>" } }
   ```
3. Poll `GET /task/:taskId` until terminal. The `output.summary` contains `{ specPath, sections, acceptanceCriteriaCount, notes }` — `specPath` is the written spec file path
4. Present the resulting spec file to the user for review
5. If the user requests changes, edit the spec and re-present

### Phase 4: Write Plan (dispatch to mma-plan)

After the user approves the spec:

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

❌ **Skipping Phase 1 (Discover).** Jumping straight to design without investigating the codebase and prior decisions produces specs that contradict existing code or re-propose dropped approaches. **Fix:** always run the three investigations (investigate + research + journal-recall) before structuring any design section.

❌ **Deciding for the user.** "I'll go with Option A since it's simpler" — NO. Present all options, recommend one with reasoning, and wait for the user to pick.

❌ **Bundling multiple sections.** Present one section at a time. If the user wants to go faster, they'll say so.

❌ **Dispatching investigations without consent.** Always propose the three investigations and wait for user agreement before dispatching.

❌ **Writing the spec inline instead of dispatching mma-spec.** The main agent gathers and structures decisions. The worker writes the formal document. Don't burn flagship tokens on formatting labor.
