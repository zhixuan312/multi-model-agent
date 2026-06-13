---
id: "0005"
title: "Preserve unknown values as null in telemetry"
category: "design"
status: "adopted"
tags:
  - telemetry
  - honest-null
  - cost-attribution
  - data-integrity
  - pricing
date: "2026-05-24"
links:
  - type: "refines"
    target: "0004"
supersededBy: null
---

## Context
Cost telemetry repeatedly failed when unresolved values were coerced into fabricated sentinels instead of being preserved as unknown. The recurring mistakes were treating an unresolved cost as `0` and emitting the literal string `custom` when the model was unknown. Both produced plausible-looking data that silently corrupted downstream aggregates.

The concrete impact was measurable. Coercing unresolved per-stage cost to `0` masked rate-card-unresolved cases and under-reported per-model savings on the dashboard: one window showed haiku savings as $304 instead of about $335 because 209 of 1254 stages contributed a fake $0. Emitting `custom` for an unknown model corrupted tier attribution badly enough to require two backend migrations and a cron alert to clean up the fallout.

The adopted rule is strict honest-null discipline: in telemetry, `null` means unknown and `0` means genuinely zero. When the model or rate card is unknown, propagate `null` end to end at every level, including per-stage fields and top-level rollups. Never invent a sentinel value to make the shape look complete.

## Consequences
Unknown must remain a first-class value throughout telemetry pipelines, storage, and aggregation. Any code path that cannot resolve a model, rate card, or derived cost must emit `null`, not `0`, `custom`, or any other fabricated stand-in.

Dashboards, reports, and attribution rollups must distinguish unknown from zero explicitly. If an aggregate mixes known and unknown inputs, the unknown portion should remain visible rather than being silently collapsed into a numeric total or synthetic tier.

During review, treat fabricated sentinels in telemetry as data-integrity bugs, not harmless defaults. A fake `0` or `custom` is worse than an honest `null` because it poisons every downstream consumer while looking valid.
