---
id: "0023"
title: "Default the complex tier to Sonnet on route-weighted review quality"
category: "decision"
status: "adopted"
tags:
  - benchmark
  - model-selection
  - complex-tier
  - read-routes
  - tiers
  - code-review
  - cost
date: "2026-06-03"
links:
  - type: "relates"
    target: "0009"
  - type: "relates"
    target: "0007"
  - type: "relates"
    target: "0011"
supersededBy: null
---

## Context
On 2026-06-01..02 a controlled benchmark ran all five read-only routes (audit, review, debug, investigate, research) across two identical rounds for five candidate complex-tier models, scoring against the universal-terminal-context-block plan and spec. Flat 0–100 rankings put Opus 4.8 at 82, Sonnet 4.6 at 80, MiniMax-M3 at 73, gpt-5.4 at 70, and DeepSeek-v4-pro at 70. But a route-weighted rubric flipped the top two: Sonnet 7.86 over Opus 7.56, because Sonnet's review found two verified critical cross-file bugs (a `registry.complete` signature mismatch and a `recorder.flush` no-op) that Opus missed, and those findings reproduced across both rounds.

The decision was to make Sonnet 4.6 the recommended default complex tier: it is cheaper than Opus, has the best review quality, and its findings are reproducible round to round. Raw aggregate score is the wrong selector here — weighting by what each route is actually for (review must catch real cross-file defects) inverts the naive leaderboard.

Per-model profiles from the same runs are worth keeping as routing intuition: gpt-5.4 is precise, fast, and expensive with a dead research route; MiniMax-M3 has the highest recall but the worst noise (42–55% precision) and ~57-minute route times at roughly 100x cheapest cost; DeepSeek-v4-pro had the best single audit round but the wildest round-to-round variance (debug produced 2 vs 20 findings on identical input) and untrustworthy line citations; Opus 4.8 had the best debug and research plus perfect citation accuracy but weak review. The full report lives at `docs/superpowers/benchmarks/2026-06-01-complex-model-benchmark/COMPARISON-REPORT.md` (local-only, gitignored).

## Consequences
Pick the default complex-tier model by route-weighted quality on the work that tier actually performs, not by a flat average across routes. A model that wins on aggregate can still be the wrong default if it loses on the route whose failures are most expensive (here, review missing verified critical bugs).

Treat round-to-round reproducibility as a first-class selection criterion. A model that emits 2 vs 20 findings on identical input (DeepSeek-v4-pro debug) is not trustworthy as a default even when it wins a single round; reproducible findings beat a high-variance high score.

Keep per-model strengths as routing hints rather than collapsing everything to one model: precision/speed (gpt-5.4), recall at low cost but high noise (MiniMax-M3), debug/research with reliable citations (Opus 4.8). Citation trustworthiness and precision/recall balance vary enough across models that route-level routing may beat a single global default later.

When re-benchmarking, hold the task (the same plan+spec target) and the round count fixed so scores are comparable, and prefer evidence that a finding reproduces over a one-round peak.
