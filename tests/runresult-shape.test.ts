import { describe, it, expectTypeOf } from 'vitest';
import type { RunResult, RawStageStats } from '../packages/core/src/types.js';

describe('RunResult shape (Phase 0 contract)', () => {
  it('exposes stageStats keyed by every stage name the telemetry schema reads', () => {
    type StageName =
      | 'implementing' | 'verifying' | 'spec_review' | 'spec_rework'
      | 'quality_review' | 'quality_rework' | 'diff_review' | 'committing';
    expectTypeOf<keyof NonNullable<RunResult['stageStats']>>().toEqualTypeOf<StageName>();
  });

  it('RawStageStats carries raw cost / duration / agent / model fields', () => {
    expectTypeOf<RawStageStats>().toMatchTypeOf<{
      entered:     boolean;
      durationMs:  number | null;
      costUSD:     number | null;
      agentTier:   'standard' | 'complex' | null;
      modelFamily: string | null;
      model:       string | null;
    }>();
  });
});
