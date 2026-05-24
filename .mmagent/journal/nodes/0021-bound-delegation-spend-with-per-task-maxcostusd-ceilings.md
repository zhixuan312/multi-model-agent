---
id: "0021"
title: "Bound delegation spend with per-task maxCostUSD ceilings"
status: "superseded"
tags:
  - cost
  - budgets
  - max-cost-usd
  - cost-caps
  - guards
  - lifecycle
  - delegation-spend
date: "2026-05-24"
links:
  - type: "depends-on"
    target: "0004"
  - type: "relates"
    target: "0001"
  - type: "relates"
    target: "0007"
supersededBy: "0022"
---

## Context
Delegation needed a caller-controlled spend guard because complex-tier workers can be materially more expensive than standard execution, especially on review-heavy paths. A task can now carry an explicit `maxCostUSD` ceiling, and the defaults block can supply the same ceiling for tasks that do not override it individually.

The lifecycle meters cumulative task cost against that ceiling and stops the task before the hard cap is fully consumed. The stop is deliberate rather than reactive: a pre-stop ratio trips slightly ahead of the exact ceiling so provider billing granularity and in-flight usage do not push the final spend past the caller's limit.

When the ceiling is hit, the task exits with a dedicated cost-cap terminal outcome such as `cost_exceeded` or `cost_cap`, and the surfaced error code is `guard_cost_ceiling`. That makes budget exhaustion an explicit lifecycle result instead of being misclassified as a generic worker failure.

## Consequences
Per-task spend control belongs in the lifecycle contract, not in caller guesswork about which tier might be cheap enough. If a caller delegates to an expensive model, the system must still enforce the declared `maxCostUSD` ceiling and stop the task predictably.

Cost-cap enforcement depends on accurate cumulative pricing, so any change to token accounting or per-stage attribution should be reviewed for its effect on guard decisions as well as telemetry correctness.

When a task stops for budget, preserve the dedicated terminal status and `guard_cost_ceiling` code. Budget exhaustion is an intentional guardrail outcome that callers can distinguish from transport, model, or implementation errors.
