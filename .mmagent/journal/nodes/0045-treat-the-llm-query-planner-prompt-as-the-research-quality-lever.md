---
id: "0045"
title: "Treat the LLM query planner prompt as the research quality lever"
category: "design"
status: "adopted"
tags:
  - research
  - query-planner
  - prompts
  - two-turn
  - freshness
  - site-filter
  - evidence-pack
date: "2026-06-13"
links:
  - type: "refines"
    target: "0015"
  - type: "depends-on"
    target: "0041"
supersededBy: null
---

## Context
The research module's two-turn pipeline makes Turn 1 the decisive point for search strategy. The LLM emits the query plan before the deterministic orchestrator fetches evidence, so decisions about freshness, news versus web search, authoritative site targeting, and `siteFilter` all happen in the planner prompt.

Adding API parameters is necessary but insufficient. The quality improvement came from the `implement.md` skill prompt teaching the planner when to use freshness, when not to use it, when to target news, and when to constrain search to authoritative sites. Parameters without planner guidance remain unused capabilities.

## Consequences
Research provider parameters and planner prompt guidance must ship together. Exposing a retrieval option without teaching the query planner when to use it does not reliably improve evidence quality.

For two-turn research, optimize Turn 1 first when quality is weak. If the query plan does not request the right strategy, the deterministic evidence builder cannot recover later.

Prompt updates for research should encode strategy rules, not just output schema. The planner needs domain guidance for freshness, endpoint selection, source authority, and site filtering.
