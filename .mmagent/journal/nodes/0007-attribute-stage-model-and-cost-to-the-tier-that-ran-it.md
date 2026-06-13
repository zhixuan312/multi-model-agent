---
id: "0007"
title: "Attribute stage model and cost to the tier that ran it"
category: "design"
status: "adopted"
tags:
  - telemetry
  - cost-attribution
  - per-stage
  - model-attribution
  - tiers
date: "2026-05-24"
links:
  - type: "refines"
    target: "0005"
  - type: "relates"
    target: "0004"
supersededBy: null
---

## Context
For a multi-release window, telemetry let reviewer and annotator stages emit `model: null` or the `custom` sentinel instead of resolving the model from the provider that actually ran that stage. The lifecycle driver's fallback then stamped the implementer's model onto those rows, so cross-tier review telemetry confidently reported the wrong reviewer model. A related regression also left `main_cost_usd` as `NULL` on every read-route event during the same period, which collapsed savings attribution.

The corrective rule is per-stage attribution, not route-level inheritance. Each LLM stage must resolve its own model from `ctx.providers[tier].config.model` for the tier that executed that stage. Missing model or cost fields must not fall back to the first actor, the implementer, or any route-wide default. Non-LLM stages such as committing and skipped review, rework, or annotate must be omitted from the wire `stages` array entirely so a zero-cost placeholder stage cannot seed a tier's model attribution.

## Consequences
Telemetry producers must treat stage identity, tier, model, and cost as one attribution unit. If a stage cannot name the provider-tier model that actually ran it, the field should remain unknown rather than borrowing a value from another stage.

When reviewing telemetry changes, treat any fallback from a missing per-stage field to a route-level or implementer-level value as an analytics bug. That kind of inheritance produces plausible but wrong attribution, which is more dangerous than an honest null because it corrupts cross-tier reporting while looking complete.

Read-route and write-route telemetry should be checked for the same failure mode: if a stage-level or top-level cost field disappears, savings attribution can silently collapse even though event volume remains normal.
