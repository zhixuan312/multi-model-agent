---
id: "0041"
title: "Audit unused API parameters before adding new research integrations"
category: "process"
status: "adopted"
tags:
  - research
  - api-audit
  - brave-search
  - freshness
  - site-filter
  - quality
date: "2026-06-13"
links:
  - type: "refines"
    target: "0015"
  - type: "relates"
    target: "0045"
supersededBy: null
---

## Context
The research module already depended on Brave Search, but it left high-value API parameters unused: freshness filtering, the news endpoint, `extra_snippets`, and `page_age`. Adding those existing parameters required no new dependency and roughly 50 lines, yet raised a financial earnings research query from 5.0/10 to 7.5/10.

The most important quality gain came from letting the LLM query planner use `siteFilter` to target `sec.gov`, which produced official SEC filings instead of secondary news blogs. The lesson was not that a new provider was needed; the existing provider surface had latent capability that the module had not exposed.

## Consequences
Before adding a new research integration, audit the current APIs for unused parameters, modes, endpoints, and evidence-volume controls. Existing provider capabilities can improve quality faster than adding another adapter.

Research quality improvements should consider both API exposure and planner affordances. A parameter only helps if the query plan can request it and the adapter honors it.

Prefer small provider-surface expansions when they unlock authoritative sources, freshness control, or richer snippets without increasing credential, dependency, or operational burden.
