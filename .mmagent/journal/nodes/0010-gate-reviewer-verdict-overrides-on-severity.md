---
id: "0010"
title: "Gate reviewer verdict overrides on severity"
category: "decision"
status: "adopted"
tags:
  - code-review
  - reviewer-verdict
  - severity
  - fail-safe
  - parsing
date: "2026-05-24"
links:
  - type: "relates"
    target: "0001"
  - type: "relates"
    target: "0008"
  - type: "relates"
    target: "0009"
supersededBy: null
---

## Context
The reviewer verdict normalizer is intentionally severity-gated, not mechanically pessimistic and not mechanically permissive. When a reviewer says `approved` but also lists findings, the parser only upgrades that verdict to `changes_required` if at least one finding is `critical` or `high`. Low- and medium-severity nits are not allowed to trigger a full rework cycle on their own when the reviewer otherwise approved the change.

The parser is also intentionally fail-safe on malformed review output. If the reviewer response cannot be parsed into a trustworthy verdict-and-findings shape, the system defaults to `changes_required` rather than failing open and shipping on ambiguous review evidence.

This distinction mattered in v4.8.0. An attempted fix for a spurious journal-review failure removed the override behavior instead of addressing reviewer route fit, and that change broke two tests that encoded the deliberate guardrail. The real problem was using a reviewer that was a poor fit for the route, not that the severity gate or unparseable-output fallback was too strict.

## Consequences
Severity is the gate for whether review findings block ship. Only `critical` and `high` findings should overturn an explicit approval and force rework; lower-severity suggestions should remain advisory unless the reviewer already issued `changes_required` directly.

Treat unparseable reviewer output as a safety failure, not as implicit approval. If the system cannot reliably recover the reviewer intent, default to `changes_required` and fix the reviewer, prompt, or route selection instead of weakening the parser.

When a review guard looks overzealous, inspect whether it is an intentional fail-safe before loosening it. The right correction is often a better-matched reviewer or tighter structured-output contract, not a broader pass condition.
