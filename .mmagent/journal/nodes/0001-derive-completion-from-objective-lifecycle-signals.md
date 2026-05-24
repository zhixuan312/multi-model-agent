---
id: "0001"
title: "Derive completion from objective lifecycle signals"
status: "adopted"
tags:
  - completion-gating
  - telemetry
  - lifecycle
  - worker-self-assessment
  - objective-signals
date: "2026-05-24"
links: []
supersededBy: null
---

## Context
In May 2026, v4.7.8 exposed a repeated completion-gating failure mode: workers often reported `completed: false` in structured output even when the lifecycle had objectively succeeded. The observed pattern was that implementation succeeded, review approved, and the commit landed, but the seal gate still downgraded the task because it trusted the worker's own pessimistic self-report. The measured impact was substantial: 68% of worker structured outputs reported `completed: false` despite successful end-to-end completion.

The adopted fix was to centralize completion judgment in a single pure function, `deriveCompletion(state)`. That function derives completion from objective lifecycle evidence only: `implementOutcome`, the review verdict, the commit-gate payload kind, rework state, and `criteriaSucceeded`. Worker self-assessment is deliberately excluded from the function signature so it cannot gate task completion.

This keeps recurring across routes. The same class resurfaced in v4.8.0 on the journal-record path when a code reviewer returned `changes_required` with zero findings on a valid markdown node. The durable lesson is to trust what objectively happened in the lifecycle over what the worker says about itself.

## Consequences
Completion gates must be driven by authoritative lifecycle signals rather than worker narration or self-assessment fields. Review approval, successful commit outcomes, and satisfied criteria are higher-trust signals than a worker's confidence report.

Worker self-assessment should still be preserved in telemetry so the system can measure how often workers assess themselves accurately, but that field must remain observational. It is useful for analysis, not control flow.

When future completion or seal-gate regressions appear, first inspect whether any gating path has reintroduced subjective worker output as an authority signal. If it has, route that logic back through objective lifecycle state instead.
