---
id: "0035"
title: One Project is one flow with a design/build regime split at the spec freeze
status: adopted
tags: [forge, decision, flow, sdlc, freeze, phase-machine]
date: 2026-06-08
links:
  - type: refines
    to: "0026"
  - type: relates
    to: "0030"
  - type: parent
    to: "0026"
supersededBy: null
---

## Context

FORGE REFINEMENT (2026-06-08): a **Project = exactly ONE flow** (not multiple
runs). The flow has **two regimes split by the spec FREEZE**:

- **DESIGN phase** — exploration ⇄ spec. **Human-driven and REVERSIBLE**: the
  user can jump back to research mid-spec, and the latest (versioned)
  exploration artifact becomes context to improve the spec.
- **FREEZE** — the **point of no return**: the user approves the finalized spec.
- **BUILD phase** — **AUTOMATIC and NO-TURN-BACK**: freeze auto-triggers
  plan-writing → multi-round audit → execute → review and runs to done. No
  stage reversal, no rework-after-finish.

Phase machine: `project.phase = design → frozen → build → done`.

This refines 0026 (Forge as the staged SDLC harness): 0026 framed the chain as
"staged … with each stage gated." This node makes the gating precise — the
**human gate is the single design freeze**, not a gate per Build stage; once
frozen, Build runs unattended end-to-end.

## Consequences

- Reversibility is confined to the DESIGN phase; exploration artifacts are
  versioned so a back-jump feeds the latest research into the spec.
- The freeze is a hard one-way transition — after it, no stage reversal and no
  post-finish rework within the same flow.
- The Build phase is autonomous: plan → audit loop → execute → review chained
  automatically (consistent with 0033's Build ordering and segment skills).
- The `project.phase` enum (`design | frozen | build | done`) is durable state
  (relates 0032's persisted run/stage model) and the component satisfaction
  gate (0030) lives inside the DESIGN phase, before freeze.
