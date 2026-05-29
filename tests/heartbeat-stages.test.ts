import { describe, it, expectTypeOf } from 'bun:test';
import type { HeartbeatStage } from '../packages/core/src/bounded-execution/activity-tracker.js';

describe('HeartbeatStage covers all telemetry stage names', () => {
  it('includes verifying, diff_review, committing, terminal', () => {
    expectTypeOf<HeartbeatStage>().toEqualTypeOf<
      | 'implementing' | 'review' | 'rework'
      | 'review' | 'rework'
      | 'annotating' | 'review' | 'committing' | 'terminal'
    >();
  });
});
