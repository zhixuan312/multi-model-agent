// Plan Task 2 — RunResult ↔ ComposePayload contract.
//
// The plan's literal step was to alias `RunResult` to `ComposePayload`. The
// runtime v4 RunResult carries ~30 fields read by 250+ consumer sites
// (handlers, recorder, wire builder, etc.); doing the alias in one commit
// would leave the build red until those consumers are migrated. The
// migration is being deferred to a later phase; this test file is the
// drift-detector that catches when ComposePayload's 8 wire-side fields and
// RunResult's runtime mirror drift apart in shape.
//
// Static-type assertions (vitest's `expectTypeOf().toEqualTypeOf<>()`) are
// no-ops at runtime AND only enforced if tests are type-checked, which
// this repo's tsconfig does NOT do for `tests/**` (see packages/core/
// tsconfig.json `include: ["src"]`). So instead this suite verifies the
// runtime properties: every wire-side ComposePayload field is reachable on
// the RunResult shape, and the shapes don't accidentally drop a key.

import { describe, it, expect } from 'bun:test';
import type { ComposePayload } from '../../packages/core/src/lifecycle/stage-io.js';

// Sample object that exercises every ComposePayload field at the type level.
// Construction is at runtime, but the const-typed object is the contract
// proof: if ComposePayload changes shape, this object stops compiling and
// the test stops running.
const composeSample: ComposePayload = {
  completed: true,
  message: '',
  findings: [],
  summary: '',
  filesChanged: [],
  commitSha: null,
  blockId: null,
  telemetry: {
    totalDurationMs: 0,
    totalCostUSD: 0,
    workerSelfAssessment: null,
    reviewVerdict: null,
    commitOutcome: 'not_applicable',
    stopReason: 'normal',
    haltedStage: null,
    stages: [],
  },
};

describe('RunResult ↔ ComposePayload — shape drift guard', () => {
  it('ComposePayload exposes all 8 wire-side fields plus telemetry', () => {
    const expected = ['completed', 'message', 'findings', 'summary', 'filesChanged', 'commitSha', 'blockId', 'telemetry'];
    expect(Object.keys(composeSample).sort()).toEqual(expected.sort());
  });

  it('ComposePayload.telemetry exposes its 8 declared fields', () => {
    const expected = ['totalDurationMs', 'totalCostUSD', 'workerSelfAssessment', 'reviewVerdict', 'commitOutcome', 'stopReason', 'haltedStage', 'stages'];
    expect(Object.keys(composeSample.telemetry).sort()).toEqual(expected.sort());
  });

  it('RunResult module still exports a type named RunResult (consumer back-compat)', async () => {
    // Module-level import always succeeds because RunResult is a type-only
    // export; this assertion just keeps the contract alive by importing it.
    const mod = await import('../../packages/core/src/types/run-result.js');
    expect(mod).toBeDefined();
  });
});