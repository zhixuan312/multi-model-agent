---
id: "0001"
title: "Derive completion from objective lifecycle signals"
category: "decision"
status: "adopted"
tags:
  - completion-gating
  - telemetry
  - lifecycle
  - worker-self-assessment
  - objective-signals
  - read-routes
  - criteria
  - smoke-testing
  - end-to-end
  - smoke-harness
  - telemetry-sinks
  - plumbing
date: "2026-05-24"
links:
  - type: "relates"
    target: "0017"
supersededBy: null
---

## Context
In May 2026, v4.7.8 exposed a repeated completion-gating failure mode: workers often reported `completed: false` in structured output even when the lifecycle had objectively succeeded. The observed pattern was that implementation succeeded, review approved, and the commit landed, but the seal gate still downgraded the task because it trusted the worker's own pessimistic self-report. The measured impact was substantial: 68% of worker structured outputs reported `completed: false` despite successful end-to-end completion.

The adopted fix was to centralize completion judgment in a single pure function, `deriveCompletion(state)`. That function derives completion from objective lifecycle evidence only: `implementOutcome`, the review verdict, the commit-gate payload kind, rework state, and `criteriaSucceeded`. Worker self-assessment is deliberately excluded from the function signature so it cannot gate task completion.

This keeps recurring across routes. The same class resurfaced in v4.8.0 on the journal-record path when a code reviewer returned `changes_required` with zero findings on a valid markdown node. The durable lesson is to trust what objectively happened in the lifecycle over what the worker says about itself.

The read routes exposed a second half of the same rule: the derived signal itself is load-bearing, so the lifecycle has to populate it before the seal gate reads it. For a period, successful investigate, audit, debug, review, and research runs all produced real findings but still sealed as `worker_status=failed` and `terminal_status=error` because read-route `lastRunResult` never populated `criteriaSucceeded`. `deriveCompletion(state)` correctly required `criteriaSucceeded.length > 0` for read-route success, but that input was always empty. The repair was to populate `criteriaSucceeded` from `routeSpec.criteria` minus the errored ids so the gate read the route's actual succeeded criteria rather than an uninitialized field.

The strongest evidence for this rule came from the live full-pipeline smoke harness at `scripts/full-smoke` (`npm run smoke:full`). That harness drives a throwaway git mini-project through every route and lifecycle stage against the running daemon, then asserts the resulting stages and correlated telemetry across all four observable sinks: the HTTP response, diagnostics JSONL, the telemetry queue NDJSON, and backend Postgres `events_raw` rows joined by `event_id`. It repeatedly caught bugs that mocked unit tests did not see because the production wiring was wrong rather than the local logic: recorder init order dropped all telemetry, `contextBlockId` never reached the execution context, multi-task commit reporting drifted, and `criteriaSucceeded` was left unpopulated. The common failure mode was ordering, threading, or end-to-end plumbing that disappeared when tests constructed lifecycle state by hand.

## Consequences
Completion gates must be driven by authoritative lifecycle signals rather than worker narration or self-assessment fields. Review approval, successful commit outcomes, and satisfied criteria are higher-trust signals than a worker's confidence report.

Worker self-assessment should still be preserved in telemetry so the system can measure how often workers assess themselves accurately, but that field must remain observational. It is useful for analysis, not control flow.

When future completion or seal-gate regressions appear, first inspect whether any gating path has reintroduced subjective worker output as an authority signal. If it has, route that logic back through objective lifecycle state instead.

Any derived signal that a gate depends on must be treated as part of the control path, not as optional bookkeeping. A gate that reads an always-empty success field will fail silently and deterministically even when the underlying work succeeded.

This class is best caught with an end-to-end smoke that exercises the real daemon and seal path, not just isolated gate logic. Unit tests that construct lifecycle state by hand can prove the decision function in isolation, but they will miss ordering, threading, and initialization bugs such as "the field was never populated" or "telemetry never attached."

Keep a live full-pipeline smoke harness in the release bar and make it assert every observable sink, not just the immediate route response. For this project, that means verifying the route result plus diagnostics output, queued telemetry, and persisted backend events for the same `event_id`, because plumbing bugs often surface in only one sink first.
