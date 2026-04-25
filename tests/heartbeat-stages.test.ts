import { describe, it, expectTypeOf } from 'vitest';
import type { HeartbeatStage } from '../packages/core/src/heartbeat.js';

describe('HeartbeatStage covers all telemetry stage names', () => {
  it('includes verifying, diff_review, committing, terminal', () => {
    expectTypeOf<HeartbeatStage>().toEqualTypeOf<
      | 'implementing' | 'spec_review' | 'spec_rework'
      | 'quality_review' | 'quality_rework'
      | 'verifying' | 'diff_review' | 'committing' | 'terminal'
    >();
  });
});
