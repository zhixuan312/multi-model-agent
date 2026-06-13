---
id: "0043"
title: "Use spec and plan audits as architecture bug gates"
category: "process"
status: "adopted"
tags:
  - spec-audit
  - plan-audit
  - architecture
  - autofix
  - dependency-order
  - api-contracts
date: "2026-06-13"
links:
  - type: "refines"
    target: "0024"
  - type: "relates"
    target: "0011"
  - type: "relates"
    target: "0041"
supersededBy: null
---

## Context
The v5.3.0 and v5.3.1 release work showed that spec-audit and plan-audit catch real architecture bugs before execution. Spec-audit found the `siteFilter` to Brave API gap, a compatibility contradiction where `count` and `extra_snippets` defaults changed while the spec claimed identical behavior, and a missing `contactEmail` config field.

Plan-audit caught a cross-task dependency on `redact-adapter-url.ts`, which was created in Task 5 while Tasks 6 and 7 were intended to run in parallel, and it caught a nonexistent `SecretRedactor.register()` API. The autofix loop resolved about 80 percent of findings; the remaining 20 percent required main-agent judgment.

## Consequences
Run spec-audit and plan-audit as architecture gates, not as cosmetic prose checks. They catch provider-surface gaps, contradictory compatibility claims, missing config fields, invalid APIs, and parallelization hazards.

Expect the autofix loop to handle the straightforward majority of findings, but reserve main-agent review for the residual set where the correct answer depends on architecture judgment or execution ordering.

When a plan has parallel tasks, plan-audit should explicitly check for produced-file dependencies across tasks. A task that creates a shared helper cannot safely run after or alongside tasks that import it.
