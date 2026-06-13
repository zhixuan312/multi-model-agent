---
id: "0009"
title: "Enforce reviewer and implementer separation by tier"
category: "decision"
status: "adopted"
tags:
  - code-review
  - cross-tier
  - reviewer-separation
  - tiers
  - quality
date: "2026-05-24"
links:
  - type: "relates"
    target: "0007"
  - type: "relates"
    target: "0008"
supersededBy: null
---

## Context
Code review only delivered its intended value when a different tier performed it from the tier that implemented the work. The failure mode was structural: the reviewer stage had been hardcoded to the standard tier regardless of who implemented, so standard-tier implementations were reviewed by the same tier that authored them. That collapsed the "second perspective" check into self-review and made "have it reviewed" operationally meaningless.

The adopted rule is to choose the reviewer by tier inversion, not by model name. When the implementer runs on the standard tier, review must run on the complex tier. When the implementer runs on the complex tier, review must run on the standard tier. In single-tier deployments where no opposite tier exists, review falls back to the implementer tier as the only available option. This preserves user sovereignty over which concrete models occupy each tier while still enforcing separation whenever the deployment can support it.

## Consequences
Reviewer selection must be derived from `TIER`, not from specific model identifiers or provider names. Any code path that hardcodes review to one tier, or that chooses the reviewer from model-name heuristics, is a regression because it breaks the structural separation guarantee.

Treat the extra review call as the cost of the check. Cheap implementations deserve a capable second opinion, and expensive implementations still benefit from an independent sanity check even if the reviewer is the lower tier.

When auditing lifecycle behavior, ask first whether the reviewer and implementer were structurally separated. If the reviewer is effectively the author, the review stage should be treated as missing its primary value even if it produced a formal verdict.
