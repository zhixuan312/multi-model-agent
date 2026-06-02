---
id: "0024"
title: "The worker harness, not the model, caps read-route quality at the top end"
status: "adopted"
tags:
  - harness
  - benchmark
  - criteria
  - read-routes
  - model-selection
  - plan-audit
date: "2026-06-03"
links:
  - type: "relates"
    target: "0023"
  - type: "relates"
    target: "0001"
  - type: "relates"
    target: "0011"
supersededBy: null
---

## Context
The same 2026-06-01..02 five-model complex-tier benchmark exposed a ceiling effect. The deepest baseline finding (F3: the plan's Task 9 golden-surface analysis is inverted — `contextBlockId` lives in the 13 `endpoints/*.json` goldens, not in `observability.json`) was missed by all ten model-rounds, including Claude Opus 4.8 running as an mma worker. Notably, that same Opus model found F3 when working as a main agent rather than as a delegated worker.

The conclusion: at the top of the model range, the binding constraint on mma read-route quality is the worker harness, not model capability. The plan-audit criteria never direct the worker to verify golden-file claims, and turn budgets cap how far the worker can explore before answering. A capable model placed in that harness still misses what it can find when unconstrained. The corollary for investment: a criteria fix — for example, adding a goldens-verification perspective to the plan-audit subtype — would lift every model simultaneously, whereas upgrading to a model above the Sonnet tier buys little for audit quality. Harness and criteria improvements are higher-leverage than model upgrades at this tier.

## Consequences
When a route underperforms at the top model tier, suspect the harness (criteria coverage, turn/exploration budgets, tool surface) before reaching for a more expensive model. The "same model finds it as a main agent but misses it as a worker" signal is direct evidence the constraint is the harness, not the model.

Criteria are leverage: a missing verification perspective (e.g. "verify golden-file claims against the actual files") caps every model at once, so fixing it lifts the whole fleet rather than one model. Prioritize criteria/harness fixes over tier upgrades for read-route audit quality.

Budget model upgrades against where they actually pay off. Above the Sonnet default tier, extra model spend buys little audit quality; spend the effort on plan-audit criteria and exploration budgets instead. This bounds the value of the model-selection decision in node 0023: Sonnet-as-default is "good enough" precisely because the next gains come from the harness, not the model.

When designing a new read-route subtype or criteria set, explicitly include perspectives that force the worker to check load-bearing structural claims (file locations, surface inventories) rather than reasoning about them from the plan text alone.
