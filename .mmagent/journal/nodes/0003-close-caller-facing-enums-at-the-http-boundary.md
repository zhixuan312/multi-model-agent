---
id: "0003"
title: "Close caller-facing enums at the HTTP boundary"
category: "decision"
status: "adopted"
tags:
  - enums
  - zod
  - validation
  - api-contract
  - drift-detection
date: "2026-05-24"
links: []
supersededBy: null
---

## Context
Over many releases, several caller-facing request fields were narrowed from permissive strings to closed enums at the HTTP schema boundary. `reviewPolicy` was reduced to exactly `{full, quality_only, diff_only, none}`, `agentType` to `{standard, complex}`, and the labor tier to `{standard, complex}`. The route layer now rejects any free-form value with HTTP 400 before it can enter lifecycle logic.

The enforcement point matters. These request shapes are validated with Zod enum schemas and `.strict()` object parsing at the boundary, so the accepted surface is explicit and closed instead of being inferred from downstream behavior. That turns the schema into the real API contract rather than a best-effort filter.

The hardening also added lockstep tests that assert each route enum set equals its corresponding `*_SUBTYPES` registration set. That catches schema-to-registration drift in CI, instead of letting a new route value or registration value silently land in one place and fail only at runtime.

## Consequences
Any caller-facing enum must be declared as a closed set at the HTTP/Zod boundary and parsed under `.strict()`. Free-form strings for these fields are a design regression because they widen the public surface and defer rejection too late.

When a new legal enum value is added, the boundary schema, route handling, and registration set must change together. A set-equality test should exist for that pairing so mismatches fail fast in CI.

During review, treat boundary-validated enums as both documentation and a tripwire: they define the legal surface, reject garbage at the edge, and prevent the class of drift bugs where a value is added in only one of the places that must remain in lockstep.
