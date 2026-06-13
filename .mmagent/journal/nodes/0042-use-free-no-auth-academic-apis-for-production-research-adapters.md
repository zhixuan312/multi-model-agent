---
id: "0042"
title: "Use free no-auth academic APIs for production research adapters"
category: "knowledge"
status: "adopted"
tags:
  - research
  - academic-apis
  - openalex
  - crossref
  - pubmed
  - no-auth
  - adapters
date: "2026-06-13"
links:
  - type: "refines"
    target: "0015"
  - type: "relates"
    target: "0041"
supersededBy: null
---

## Context
Academic search does not require a paid provider or mandatory API keys for production viability. OpenAlex exposes more than 250 million works with a 100,000 credits/day policy and CC0 data. Crossref exposes more than 150 million DOI records at roughly 50 requests/second without auth. PubMed exposes more than 35 million papers at 3 requests/second without a key, or 10 requests/second with a free key.

These APIs return JSON, have generous enough rate limits for the research route, and were validated by fetching real API documentation and building three production adapters.

## Consequences
Do not assume academic research requires paid APIs, proprietary search products, or credentials. OpenAlex, Crossref, and PubMed should be considered first-class candidates for bibliography-oriented research retrieval.

Adapter planning should distinguish optional credentials from required credentials. Free keys may improve rate limits, but the route should still be able to produce useful evidence from no-auth academic sources.

For research tasks that need papers, DOIs, biomedical literature, or citation metadata, prefer these no-auth JSON APIs before reaching for generic web search alone.
