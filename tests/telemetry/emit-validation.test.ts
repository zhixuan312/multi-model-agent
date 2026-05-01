import { describe, it, expect } from 'vitest';
import { buildTaskCompletedEvent } from '../../packages/core/src/telemetry/event-builder.js';
import { ValidatedTaskCompletedEventSchema } from '../../packages/core/src/telemetry/types.js';
import { richRunResult } from '../contract/telemetry/fixtures/rich-runresult.js';

describe('V3 cross-field validation (warn-only since 3.10.3)', () => {
  // 3.10.3 reverted 3.10.2's drop-on-superRefine behaviour: cross-field rule
  // violations now emit a warning but the event still ships. Schema-level
  // bounds (caps, types, enums) still drop. These tests verify the schema
  // CAN detect the violations — what the recorder does with that signal
  // (drop vs warn vs emit) is a separate policy. See recorder.ts comments.

  it('R3 detection: review.model === implementerModel produces a schema warning', () => {
    const rr = richRunResult();
    rr.stageStats!.spec_review.model = rr.models!.implementer;
    const ev = buildTaskCompletedEvent({ route: 'delegate', taskSpec: { filePaths: [] }, runResult: rr, client: 'test', parentModel: null });
    const parsed = ValidatedTaskCompletedEventSchema.safeParse(ev);
    expect(parsed.success).toBe(false);
    if (!parsed.success) {
      const r3 = parsed.error.issues.find((e) => e.message.toLowerCase().includes('r3'));
      expect(r3).toBeDefined();
    }
  });

  it('R10b detection: rework stage on quality_only route produces a schema warning', () => {
    const rr = richRunResult();
    const ev = buildTaskCompletedEvent({ route: 'audit', taskSpec: { filePaths: [] }, runResult: rr, client: 'test', parentModel: null });
    const parsed = ValidatedTaskCompletedEventSchema.safeParse(ev);
    expect(parsed.success).toBe(false);
  });
});
