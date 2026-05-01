import { describe, it, expect } from 'vitest';
import { buildTaskCompletedEvent } from '../../packages/core/src/telemetry/event-builder.js';
import { ValidatedTaskCompletedEventSchema } from '../../packages/core/src/telemetry/types.js';
import { richRunResult } from '../contract/telemetry/fixtures/rich-runresult.js';

describe('emit-time V3 validation', () => {
  it('emit path rejects R3-violating events (review.model === implementerModel)', () => {
    const rr = richRunResult();
    // Force violation: make spec_review.model match implementerModel
    rr.stageStats!.spec_review.model = rr.models!.implementer;
    const ev = buildTaskCompletedEvent({ route: 'delegate', taskSpec: { filePaths: [] }, runResult: rr, client: 'test', parentModel: null });
    const parsed = ValidatedTaskCompletedEventSchema.safeParse(ev);
    expect(parsed.success).toBe(false);
    if (!parsed.success) {
      const r3 = parsed.error.issues.find(
        (e) => e.message.toLowerCase().includes('r3'),
      );
      expect(r3).toBeDefined();
    }
  });

  it('R10b: rework stage on quality_only route is rejected', () => {
    const rr = richRunResult();
    // Already has spec_rework and quality_rework entered; emit on `audit` route which is quality_only.
    const ev = buildTaskCompletedEvent({ route: 'audit', taskSpec: { filePaths: [] }, runResult: rr, client: 'test', parentModel: null });
    const parsed = ValidatedTaskCompletedEventSchema.safeParse(ev);
    expect(parsed.success).toBe(false);
  });
});
