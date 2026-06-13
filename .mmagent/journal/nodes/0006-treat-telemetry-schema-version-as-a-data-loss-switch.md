---
id: "0006"
title: "Treat telemetry schema version as a data-loss switch"
category: "decision"
status: "adopted"
tags:
  - telemetry
  - schema-version
  - wire-schema
  - data-loss
  - greenfield
date: "2026-05-24"
links:
  - type: "refines"
    target: "0002"
  - type: "relates"
    target: "0005"
supersededBy: null
---

## Context
`SCHEMA_VERSION` in the telemetry wire schema is not a passive changelog marker. In the flusher, any queued record whose `schemaVersion` is older than the current constant is dropped before upload (`packages/server/src/telemetry/flusher.ts:143`). That makes a version bump an operational data-loss switch for in-flight local queue contents on the next deploy, not a harmless bookkeeping step.

This matters because the project deliberately develops telemetry in greenfield mode. Wire field semantics can change, fields can be renamed or removed, and obsolete meaning can be overwritten without preserving backward-compatibility shims. In that mode, bumping `SCHEMA_VERSION` just because a field changed is the wrong instinct when the wire payload still belongs to the same forward-only generation: it silently discards real queued telemetry that would otherwise upload successfully.

The concrete correction was to keep `SCHEMA_VERSION` pinned at `5` while field meaning evolved, and add a contract test (`tests/contract/wire-schema-version.test.ts`) that fails if the constant is bumped casually. The lesson is to inspect what a schema-version constant actually triggers in production before touching it; here, "bump it to be safe" would have thrown away queued events.

## Consequences
Treat telemetry schema-version changes as operational migrations, not documentation updates. Only bump `SCHEMA_VERSION` when intentionally invalidating queued records is acceptable and coordinated.

For greenfield telemetry changes that only redefine field meaning, remove fields, or rename wire keys without requiring queue invalidation, keep the version fixed and let semantics evolve under the no-backward-compat rule.

During review, treat any proposed `SCHEMA_VERSION` bump as a data-retention decision that needs explicit justification. A pinning test is warranted so routine field churn cannot slip a destructive version change into an otherwise safe refactor.
