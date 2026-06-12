---
id: "0038"
title: Public Projects share equal rights; spec components map to role owners
status: adopted
tags: [forge, spec, collaboration, decision, flow, mermaid, satisfaction-gate]
date: 2026-06-08
links:
  - type: refines
    to: "0030"
  - type: relates
    to: "0037"
  - type: parent
    to: "0026"
supersededBy: null
---

## Context

FORGE COLLABORATION + SPEC COMPONENTS (2026-06-08): a **public Project** = all
members share the flow with **EQUAL rights** (answer Q&A, edit, force-advance);
they **self-organize by component.**

Spec components map to **role owners** (`component.primary_roles` drives the
routing):

- **Context** — biz user + PM
- **Problem statement & goals** — biz + PM
- **Technical design** — SWE: technical options → selected option + rationale →
  high-level impl design → flow charts → scope/boundaries
- **Test plan** — biz + QE
- **User stories & tech tasks** — PM + SWE + QE

**Flow charts** are authored as **Mermaid** in the markdown artifact
(`react-markdown` + `mermaid`, **still no MDX**).

This refines 0030's per-component satisfaction gate: the `component` now also
carries `primary_roles`, and the Q&A participants are scoped by role within the
equal-rights public-project model (relates 0037 visibility/membership).

## Consequences

- `component.primary_roles` is a routing field that pairs each spec component
  with the roles expected to own/answer it; the satisfaction gate (0030) runs
  per component as before.
- Public-project collaboration is flat (equal rights, self-organizing); the
  force-advance path from 0030 is available to any member, consistent with
  0037's no-RBAC tenancy.
- Flow charts ship as Mermaid embedded in markdown rendered via react-markdown +
  mermaid; do NOT introduce MDX.
- The Technical-design component encodes a decision-trace sub-structure (options
  → selected + rationale → impl design → flow charts → scope), so the spec
  artifact schema must hold that nested shape.
