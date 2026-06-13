---
id: "0026"
title: Forge is the human-facing harness for the MMA SDLC flow
category: decision
status: adopted
tags: [forge, decision, sdlc, product, mma-integration]
date: 2026-06-08
links:
  - type: relates
    to: "0020"
supersededBy: null
---

## Context

DECISION (2026-06-08): We are building **Forge** — a new, server-deployed web
app that is the human-facing harness for the MMA SDLC flow. It mirrors
`mma-flow`: staged Exploration → Spec → Plan → Execute → Review, with each
stage gated. Forge's purpose is to guide an engineer through AI-assisted
SDD+TDD from idea to committed code.

Division of labour: **MMA executes each stateless "rod"** (the per-stage
delegated work), while **Forge owns the chain and the gates** — exactly the
role Claude Code plays in `mma-flow` today.

Forge is a **DISTINCT product surface**, separate from:
- the multi-model-agent library/server (the rod executor), and
- the telemetry dashboard.

This is the root node for the Forge initiative; subsequent Forge nodes refine
its architecture, design, stack, state model, build plan, and process. It
relates to 0020 (route all lifecycle control through the single invocation
surface) because Forge is the human-facing chain-owner that drives that
invocation surface from outside, over HTTP.

## Consequences

- Forge is scoped as a product, not a feature of mma — it gets its own repo,
  schema, and lifecycle (see 0027, 0032).
- The "chain + gates" responsibility lives in Forge; mma stays stateless and
  per-rod. Do not push chain/gate state into mma.
- Forge replaces the human-in-Claude-Code role of `mma-flow`, so it inherits
  mma-flow's stage model and its execution invariants downstream (see 0033).
