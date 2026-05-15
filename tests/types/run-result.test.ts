import { describe, it, expectTypeOf } from 'vitest';
import type { RunResult } from '../../packages/core/src/types/run-result.js';
import type { ComposePayload } from '../../packages/core/src/lifecycle/stage-io.js';

describe('RunResult is ComposePayload', () => {
  it('the two types are identical', () => {
    expectTypeOf<RunResult>().toEqualTypeOf<ComposePayload>();
  });
});