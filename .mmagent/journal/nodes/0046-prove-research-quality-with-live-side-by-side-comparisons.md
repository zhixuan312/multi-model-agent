---
id: "0046"
title: "Prove research quality with live side-by-side comparisons"
category: "process"
status: "adopted"
tags:
  - research
  - quality
  - live-comparison
  - evidence-pack
  - scoring
  - regression-proof
date: "2026-06-13"
links:
  - type: "refines"
    target: "0023"
  - type: "relates"
    target: "0041"
  - type: "relates"
    target: "0045"
supersededBy: null
---

## Context
The definitive proof for the research quality improvement was a live A/B comparison: v5.2.2 on port 7337 and v5.3.0 on port 7338 ran the same query, and their evidence packs were compared side by side. Unit tests with mocked HTTP proved structural correctness, but they could not prove that the system retrieved better evidence.

An eight-dimension, 1-10 scoring framework made the improvement communicable. It turned the qualitative difference between evidence packs into a concrete comparison that could support a release claim.

## Consequences
Before claiming a research quality improvement, run a live comparison against the previous version with the same query and compare evidence packs side by side.

Keep mocked HTTP tests for structure, contracts, and regression coverage, but do not treat them as evidence of quality improvement. Live retrieval behavior is the proof surface for research quality.

Use a consistent scoring rubric when reporting quality changes. A shared dimensional score makes the difference reviewable and prevents vague claims from standing in for evidence.
