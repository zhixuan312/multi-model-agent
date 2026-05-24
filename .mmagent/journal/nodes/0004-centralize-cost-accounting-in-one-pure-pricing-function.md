---
id: "0004"
title: "Centralize cost accounting in one pure pricing function"
status: "adopted"
tags:
  - cost
  - pricing
  - tokens
  - telemetry
  - pure-function
  - normalization
date: "2026-05-24"
links:
  - type: "relates"
    target: "0001"
supersededBy: null
---

## Context
Before v3.12.2, pricing logic was computed in multiple runners and telemetry paths with inconsistent token semantics. Some sites treated cached tokens as if they were part of input, others special-cased providers, and the resulting cost accounting drifted because the same number was recomputed in too many places.

The adopted fix was to move all pricing through one pure function, `priceTokens(tokenCounts, rateCard)`, over a single canonical usage shape shared by every runner: `{inputTokens, outputTokens, cachedReadTokens, cachedNonReadTokens}`. In that shape, `inputTokens` means non-cached input only and explicitly excludes cache reads and cache writes. Cache-read and cache-write costs are additive on top of the base input price, so the computation is a straight sum of independently priced token classes rather than a subtractive formula.

The normalization boundary is the provider adapter, not the pricing function. Claude, OpenAI-compatible, and Codex producers must all emit the same sibling-semantic shape before cost is computed. That keeps the consumer trivial: `priceTokens` should never branch on provider-specific usage formats or cache conventions.

## Consequences
Any future cost, main-equivalent-cost, or per-stage pricing path must call the same pure pricing function instead of reimplementing token math locally. If a new billing rule appears, update the shared rate card and function once rather than patching each runner.

Provider-specific usage quirks must be normalized at the source into the canonical four-field token shape. If a consumer needs to know which provider produced the usage object to price it correctly, the design has already regressed.

When reviewing telemetry or pricing changes, treat duplicated cost formulas and ambiguous token semantics as structural risks. The durable lesson is that widely recomputed numbers drift unless their input shape is canonical and their computation is centralized.
