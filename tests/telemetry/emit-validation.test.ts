import { describe, it, expect } from 'vitest';
import { buildTaskCompletedEvent } from '../../packages/core/src/events/event-builder.js';
import { ValidatedTaskCompletedEventSchema } from '../../packages/core/src/events/telemetry-types.js';
import { richRunResult } from '../contract/telemetry/fixtures/rich-runresult.js';

describe('V3 cross-field validation (warn-only since 3.10.3)', () => {
  // 3.10.3 reverted 3.10.2's drop-on-superRefine behaviour: cross-field rule
  // violations now emit a warning but the event still ships. Schema-level
  // bounds (caps, types, enums) still drop. These tests verify the schema
  // CAN detect the violations — what the recorder does with that signal
  // (drop vs warn vs emit) is a separate policy. See recorder.ts comments.

  // R3 was intentionally removed in v4 — review tier equality with
  // implementer tier is no longer a schema violation. Cross-tier
  // differentiation is now reflected in tierUsage rollup, not enforced
  // at the stage level. See §3.4 for current rule set.
  it('R3 removal: review.tier === implementerTier no longer fails validation (v4)', () => {
    const rr = richRunResult();
    rr.stageStats!.spec_review.agentTier = 'standard';
    const ev = buildTaskCompletedEvent({ route: 'delegate', taskSpec: { filePaths: [] }, runResult: rr, client: 'test', mainModel: null });
    const parsed = ValidatedTaskCompletedEventSchema.safeParse(ev);
    expect(parsed.success).toBe(true);
  });

  it('R10b detection: rework stage on quality_only route produces a schema warning', () => {
    const rr = richRunResult();
    const ev = buildTaskCompletedEvent({ route: 'audit', taskSpec: { filePaths: [] }, runResult: rr, client: 'test', mainModel: null });
    const parsed = ValidatedTaskCompletedEventSchema.safeParse(ev);
    expect(parsed.success).toBe(false);
  });
});
