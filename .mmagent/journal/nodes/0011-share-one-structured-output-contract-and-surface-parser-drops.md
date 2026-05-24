---
id: "0011"
title: "Share one structured-output contract and surface parser drops"
status: "adopted"
tags:
  - findings-format
  - structured-output
  - parsing
  - prompts
  - observability
  - validation-warnings
  - read-routes
date: "2026-05-24"
links:
  - type: "relates"
    target: "0010"
  - type: "relates"
    target: "0008"
  - type: "relates"
    target: "0001"
supersededBy: null
---

## Context
Across read routes, structured findings only became reliable once the producer and consumer were pinned to the same single output contract. The standardized contract is `## Finding N:` headings followed by labeled bullets, and both the implementer prompt and the deterministic extractor now reference that exact format instead of each side inventing its own shape.

The failure mode was repeated format drift with silent data loss. In one case, a worker emitted bold-numbered findings like `**1.**`; the extractor expected heading-based findings, parsed zero records, and still returned a seemingly successful envelope after burning roughly 20K output tokens across 64 tool calls for $1.04 with nothing recorded. In another regression, severity bullets were not matched, so 30 findings all defaulted to `medium`, hiding the real severity distribution while preserving a plausible-looking result.

The corrective pattern had two parts. First, define one shared contract between prompt and parser, then make the parser tolerant of heading and bullet variants so minor output drift does not zero out useful work. Second, never drop malformed or unmatched blocks silently: every dropped or partially parsed block must be surfaced in `envelope.validationWarnings` so operators can see when a large worker output yielded zero findings or suspicious defaults.

## Consequences
When an LLM is expected to produce structured output, the prompt, parser, tests, and examples must all name the same single wire format. Parallel "preferred" formats are a design bug because they guarantee eventual producer-consumer drift.

Parser tolerance is a resilience layer, not permission for contract ambiguity. The canonical format should remain singular and explicit, while the extractor accepts nearby heading and bullet variants to salvage valid work when a worker deviates slightly.

Dropped, malformed, or defaulted blocks must be observable at the envelope level. If parsing falls back, recovers partially, or records zero findings from a substantial response, `validationWarnings` should make that visible immediately rather than letting the route look clean while data was lost.

When findings counts or severity distributions look suspiciously low or flat, inspect prompt-parser contract drift before blaming the worker model. Plausible-looking defaults are often a parser bug with observability missing, not genuine absence of findings.
