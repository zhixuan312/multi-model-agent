---
id: "0025"
title: "Terminal-stage lifecycle bug catalog from the cross-model audit"
category: "knowledge"
status: "adopted"
tags:
  - bugs
  - terminal-stage
  - lifecycle
  - telemetry
  - contract-tests
  - benchmark
date: "2026-06-03"
links:
  - type: "relates"
    target: "0008"
  - type: "relates"
    target: "0001"
  - type: "relates"
    target: "0023"
supersededBy: null
---

## Context
The 2026-06-01..02 five-model benchmark doubled as a code audit of the terminal-stage lifecycle and surfaced ten cross-model-verified real bugs that need a dedicated fix plan. The full bug table is in `docs/superpowers/benchmarks/2026-06-01-complex-model-benchmark/COMPARISON-REPORT.md` (local-only). The top five, recorded here so the fixes are not lost:

1. CRITICAL — `terminal-handlers.ts:93` calls `registry.complete(taskIndex, result)`, but the real `BatchRegistry.complete` signature is `complete(batchId: string)` at `batch-registry.ts:209`. A structural `BatchRegistryLike` type plus a surrounding `try/catch` hide the mismatch, so the terminal handler never actually marks the batch complete.
2. CRITICAL — `flushTelemetryHandler` is a permanent no-op because the declared `ExecutionContext.recorder` type (`lifecycle-context.ts:107`) has no `flush()` method.
3. HIGH — `envelope.snapshot()` at `terminal-handlers.ts:45` sits outside the `try` block, so a throw there bypasses the AC-6 warning path.
4. HIGH — the missing-deps early return at `terminal-handlers.ts:44` is silent (no validation warning), contradicting spec AC-6.
5. HIGH — `tests/contract/serializer/normalize.ts:31` masks `contextBlockId` as DETERMINISTIC in goldens, so contract tests cannot catch a null-`contextBlockId` regression.

Further findings: `TerminalPayload` flags report success on failure (contradicting the docstring at lines 222–225); flush-telemetry runs before seal; and AC-6 was never ratified by any test, which is why the `5a58bd51` silent-null regression shipped green.

## Consequences
Two of the criticals are the failure mode from node 0008 (one canonical read/write path per lifecycle fact) re-appearing: structural/`BatchRegistryLike` typing plus a swallowing `try/catch` let a signature mismatch (`registry.complete`) compile and run while silently doing nothing. Prefer exact (nominal) typing on lifecycle registry calls over structural shapes, and never wrap a state-transition call in a catch that hides a wrong-arity or wrong-signature call.

A handler whose backing type lacks the method it calls (`recorder.flush()`) is a permanent no-op, not a runtime error — the type system should make the method's absence a compile failure, not allow a silent dead path. Telemetry flush belongs after seal, not before it.

AC-6 (terminal-stage validation warnings) shipping unratified by any test is the same class as node 0001: a spec acceptance criterion with no end-to-end assertion will regress silently and green. Every load-bearing AC needs a test that fails when the behavior is removed, and goldens must not normalize away the very field whose regression they should catch (`contextBlockId` masked as DETERMINISTIC defeats its own contract test).

This catalog is a fix-plan backlog, not a resolved item: the entries above are open bugs to be planned and fixed, and this node should be revisited (and superseded or refined) once that plan lands.
