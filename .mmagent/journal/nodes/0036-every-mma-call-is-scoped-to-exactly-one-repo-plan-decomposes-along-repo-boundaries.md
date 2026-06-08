---
id: "0036"
title: Every MMA call is scoped to exactly one repo; Plan decomposes along repo boundaries
status: adopted
tags: [forge, decision, architecture, one-repo-per-call, multi-repo, mma-integration, write-routes]
date: 2026-06-08
links:
  - type: refines
    to: "0033"
  - type: relates
    to: "0028"
  - type: relates
    to: "0032"
  - type: relates
    to: "0013"
  - type: parent
    to: "0026"
supersededBy: null
---

## Context

FORGE HARD RULE (2026-06-08): MMA **always operates on ONE repo per call**
(`?cwd=<one repo>`). A **Project spans many repos**, but **every task**
(investigate, audit, and each Plan task) **must be scoped to exactly one repo.**

- The **Plan stage decomposes work ALONG REPO BOUNDARIES.**
- **Multi-repo stages fan out one MMA call per repo and aggregate** the results.
- `mma_batch.target_repo_id` **enforces** the one-repo scoping at the data layer.
- **Execute**: **one-writer-per-cwd** (parallel across *disjoint* repos,
  sequential *within* a repo), **per-run branches**, **MMA owns the commit
  stage**.

This refines 0033's Stage-4 execution invariants and makes the ?cwd= contract
of 0028 a per-task hard rule: co-located mmagent is always pointed at a single
repo workspace, never a multi-repo span.

## Consequences

- The fan-out/aggregate pattern is the only way to act across repos; there is no
  multi-repo MMA call. Forge orchestrates one call per repo and merges.
- `mma_batch` carries `target_repo_id` (extends the 0032 schema spine) so every
  dispatch is auditably bound to one repo.
- Concurrency follows 0013/0012: parallel only across disjoint cwds, serialized
  within a repo; per-run branches; no worker self-commit — MMA owns commit.
- Plan authoring must split tasks so each lands in a single repo; a task that
  would touch two repos is a decomposition error.
