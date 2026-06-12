---
id: "0033"
title: Forge build plan — staged sub-projects, Foundation+Spec first, Execute last and highest-risk
status: adopted
tags: [forge, decision, sdlc, build-plan, mma-integration, security]
date: 2026-06-08
links:
  - type: parent
    to: "0026"
  - type: depends-on
    to: "0032"
  - type: depends-on
    to: "0028"
  - type: relates
    to: "0013"
  - type: relates
    to: "0012"
supersededBy: null
---

## Context

BUILD PLAN (Forge): decompose into sub-projects; do **NOT** write one monolith
spec. Order:

0. **Foundation** — Next scaffold + Drizzle schema/migrations + MmaClient
   (202 + poll) + AnthropicClient (structured-output helper) + pro-gate +
   app shell/stepper.
1. **Spec stage** — component multi-select → codebase-grounded per-component
   Q&A with the dynamic satisfaction gate → draft → assemble →
   `mma-audit(subtype=spec)` loop → design-freeze gate.
2. **Exploration** — `mma-explore` fan-out → directions feeding Spec.
3. **Plan** — writing-plans logic → `mma-audit(subtype=plan)` loop.
4. **Execute + Review** — segment-execute, workspace/repo model, verify gate,
   `mma-review`.

**First slice = Foundation + Spec** (proves Drizzle runs, structured-output
interview, MMA-over-HTTP, and a human gate).

**Stage 4 is LAST and HIGHEST risk**: a server with WRITE access to multiple
repos + running mmagent (executes code/git/codex) is high-trust. It needs
**real per-repo authorization beyond the pro-gate**, and it inherits all
mma-flow execution invariants: **one writer per cwd, MMA owns the commit stage,
no worker self-commit**.

## Consequences

- Build incrementally; the Foundation+Spec slice de-risks the four hardest
  unknowns at once (Drizzle, structured outputs, mma-over-HTTP, human gate).
- Depends on the state schema (0032) and the mma HTTP boundary (0028).
- Stage 4 inherits the same-repo concurrency invariants captured in 0013
  (parallel dispatch with scoped commits / commit-mutex) and the serialization
  concern in 0012 — apply one-writer-per-cwd and "MMA owns commit" rules.
- Per-repo authorization for write/execute is a distinct security requirement
  beyond the pro-gate; treat target repos as untrusted, high-trust surface
  (relates 0027's repo table).
