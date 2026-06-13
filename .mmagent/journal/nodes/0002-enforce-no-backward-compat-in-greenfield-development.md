---
id: "0002"
title: "Enforce no backward compatibility in greenfield development"
category: "decision"
status: "adopted"
tags:
  - development-mode
  - no-backward-compat
  - cleanup
  - dead-code
  - one-implementation-per-concept
date: "2026-05-24"
links: []
supersededBy: null
---

## Context
This project develops in a deliberate greenfield, pre-1.0-style mode where backward-compatibility scaffolding is treated as technical debt rather than safety. The rule is operationally simple: when code changes, overwrite the old path directly instead of leaving compatibility shims, `@deprecated` markers, re-exports for renamed or moved symbols, migration code for retired data shapes, or otherwise-unused call paths behind.

That rule was reinforced across the cleanup releases from v4.7.11 through v4.7.19. Those releases repeatedly removed dead code only after verifying each candidate was zero-reference repo-wide and gating the deletion on a clean build, the full test suite, and a passing smoke run. The same discipline also applies at the telemetry boundary: field semantics may change without a back-compat shim when the project decides the old meaning is obsolete.

The durable lesson is that, in this development mode, every concept should have exactly one live implementation. When a new implementation replaces an old one, the old one should be deleted in the same change instead of being left callable for hypothetical compatibility.

## Consequences
Future refactors and feature work should remove replaced symbols, routes, helpers, exports, and obsolete data-shape handling immediately, rather than staging them behind compatibility layers.

Cleanup-only changes are valid and encouraged, but only after proving the target is zero-reference across the repository and re-running the same verification bar: clean build, full tests, and smoke coverage.

When reviewing changes, treat shims, re-exports, migration glue for retired formats, and lingering `@deprecated` paths as design regressions unless there is an explicit, higher-priority reason to preserve them.
