---
id: "0030"
title: Per-component dynamic satisfaction gate for Forge spec Q&A
status: adopted
tags: [forge, design, decision, sdlc, satisfaction-gate, mma-integration]
date: 2026-06-08
links:
  - type: parent
    to: "0026"
  - type: refines
    to: "0029"
  - type: depends-on
    to: "0028"
supersededBy: null
---

## Context

KEY DESIGN (Forge): a **per-component dynamic satisfaction gate** drives spec
Q&A. Component lifecycle:

`component.status: gathering → satisfied → drafted → approved`

Each Q&A round:
- The AI emits a structured payload `{ aiSatisfied, missingInfo[],
  followUpQuestions[] }`, **grounded by `mma-investigate`** against the target
  repo.
- The human answers and sets `humanSatisfied`.

Advance rule:
- **Auto-advance IFF `aiSatisfied AND humanSatisfied`.**
- A human **FORCE-advance overrides `aiSatisfied`** at any time.
- **Rounds are unbounded.**

Q&A is **codebase-grounded**: fire `mma-investigate` / `mma-explore` so
questions reference real modules — never blind.

## Consequences

- This refines the Q&A workflow (0029): the workflow loop's per-turn structured
  output IS the `{aiSatisfied, missingInfo, followUpQuestions}` payload.
- It depends on co-located mma over HTTP (0028) for grounding — investigate/
  explore must hit the real target repo via `?cwd=`.
- The `component.status` machine maps onto persisted state (see 0032: the
  `component` and `qa_turn` tables).
- Human force-advance is a first-class path; never block on `aiSatisfied`.
