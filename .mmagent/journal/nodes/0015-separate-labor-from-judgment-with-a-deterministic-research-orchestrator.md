---
id: "0015"
title: "Separate labor from judgment with a deterministic research orchestrator"
status: "adopted"
tags:
  - research
  - labor-vs-judgment
  - two-turn
  - orchestrator
  - determinism
  - query-plan
  - evidence-pack
date: "2026-05-24"
links:
  - type: "relates"
    target: "0008"
  - type: "relates"
    target: "0011"
supersededBy: null
---

## Context
The research route became reliable only after separating external retrieval labor from synthesis judgment. The worker now runs with `tools: "none"` and never calls native `WebSearch` or `WebFetch` directly. Instead, research is a two-turn pipeline: turn 1 emits a structured `QueryPlan`; a deterministic step-2 orchestrator fans that plan out across bibliographic adapters such as `arxiv`, `semantic_scholar`, `github_search`, and `brave`, with explicit timeouts, a host allowlist, and a fixed query budget; turn 2 reasons over the pre-built `EvidencePack` returned by that orchestrator.

That boundary matters because the failure mode was worker improvisation around external I/O. When one component both fetches and judges, the retrieval surface becomes hard to test, hard to budget, and easy to bypass with ad hoc tool choices. Pulling retrieval into a deterministic host-side orchestrator makes the labor surface unit-testable and budget-bounded while preserving the worker's role as synthesis over a fixed evidence set.

The route also proved that missing credentials should not turn into route failure when the remaining evidence sources still suffice. If an adapter lacks an API key, it is skipped silently and the request still succeeds with the evidence collected from the adapters that were available.

## Consequences
When a workflow mixes external I/O and reasoning, split them explicitly. The worker should describe the retrieval plan and synthesize the result, but the host orchestrator should own all network fan-out, adapter selection, timeouts, allowlists, and query-budget enforcement.

Research workers must not retain an improvisable web-search escape hatch once the orchestrator exists. Giving the worker direct search or fetch tools reintroduces the same nondeterministic labor surface this design removes.

The retrieval artifact should be a deterministic intermediate such as `QueryPlan` in and `EvidencePack` out. That makes the labor half straightforward to unit test, replay, budget, and audit independently from model reasoning quality.

Credential absence should degrade capability, not correctness. Skip unavailable adapters, record only the evidence that was actually gathered, and let synthesis proceed over that bounded pack instead of failing the whole route for partial provider unavailability.
