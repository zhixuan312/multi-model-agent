---
id: "0022"
title: "Prefer focus and explicit user budgets over engine cost caps"
status: "adopted"
tags:
  - cost
  - budgets
  - focus
  - autonomous-execution
  - no-cost-caps
  - api-contract
  - completion
date: "2026-05-24"
links:
  - type: "supersedes"
    target: "0021"
  - type: "depends-on"
    target: "0004"
  - type: "relates"
    target: "0001"
  - type: "relates"
    target: "0007"
supersededBy: null
---

## Context
The earlier `maxCostUSD` design was removed in v4.7.0. The system no longer carries arbitrary per-task USD spend ceilings in defaults, task specs, run options, or the `/delegate` and `/execute-plan` HTTP contract. `defaults.maxCostUSD`, `tasks[].maxCostUSD`, the `TaskSpec` and `RunOptions` slots, and the entire `cost_exceeded` / `cost_cap` / `guard_cost_ceiling` lifecycle surface were deleted. Sending the field now fails at the boundary with `400` instead of being accepted and enforced.

The important distinction is that reported cost remains part of the product. `actualCostUSD` and the pricing/accounting path are unchanged; what disappeared is the engine-level cap that pre-stopped work mid-flight to stay under an internally enforced number.

The reason for the reversal is outcome quality, not accounting convenience. A long-running autonomous task that gets killed on spend produces a half-done, uncommitted result at the exact moment the caller needed completion. For plan execution in particular, the caller already asked the system to drive work through to completion without budget-based check-ins. Legitimate caller constraints still apply when they are explicit, such as a provided `timeoutMs` or a user-stated ceiling, but the engine should not invent its own mid-task spend abort.

## Consequences
Do not reintroduce per-task engine cost caps as a lifecycle guardrail. If work needs to cost less, narrow the task with better focus or honor an explicit caller/user budget constraint; do not stop autonomous execution halfway through because an internal ceiling fired.

HTTP and type contracts should reject removed budget-cap fields rather than silently ignoring them. The durable lesson is that a cost cap on an in-flight agent task trades a complete result for an incomplete one, which is usually worse than the spend it saved.
