---
id: "0032"
title: Forge persists resumable workflow state in Postgres via Drizzle
status: adopted
tags: [forge, architecture, decision, state, drizzle, postgres, sdlc]
date: 2026-06-08
links:
  - type: parent
    to: "0026"
  - type: depends-on
    to: "0031"
  - type: relates
    to: "0030"
supersededBy: null
---

## Context

STATE + SCOPE (Forge): workflow state is persisted in **PostgreSQL via
Drizzle**. Schema spine:

`repo → workflow_run(repo_id, stage) → stage → component → qa_turn → artifact → mma_batch`

- **Runs are resumable** (state lives in Postgres, not in memory).
- **Scope is the FULL SDLC pipeline through committed code.**

## Consequences

- The `component` / `qa_turn` tables back the satisfaction-gate state machine
  (relates 0030); `mma_batch` records the 202-then-poll dispatches (0028).
- Resumability is a design requirement — every stage transition and gate
  decision must be durable, so a run can be reopened across sessions.
- Depends on the chosen stack (0031: Drizzle 0.45 stable + PostgreSQL 17); do
  not adopt Drizzle v1 beta.
- Scope is end-to-end (idea → committed code), so the schema must carry through
  the Execute/Review stages, not just Spec.
