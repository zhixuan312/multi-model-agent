import { describe, it, expect } from 'vitest';
import { TaskCompletedEventSchema, ImplementStageEntrySchema, ReviewStageEntrySchema, ReworkStageEntrySchema, VerifyStageEntrySchema, CommitStageEntrySchema } from '../../packages/core/src/telemetry/types.js';
import { TASK_COMPLETED_FIELD_COVERAGE, STAGE_FIELD_COVERAGE } from '../../packages/core/src/telemetry/field-coverage.js';

describe('field-coverage manifest', () => {
  it('covers every top-level event field in V3 schema (set equality)', () => {
    // Note: object-literal manifests can't have duplicate keys at runtime
    // (later assignment overwrites earlier), so this is a set-equality check
    // proving "every schema field has a manifest entry", not literal "exactly
    // once" duplicate detection.
    const schemaKeys = Object.keys(TaskCompletedEventSchema.shape);
    const manifestKeys = Object.keys(TASK_COMPLETED_FIELD_COVERAGE);
    expect(new Set(manifestKeys)).toEqual(new Set(schemaKeys));
  });

  it('covers every stage variant\'s fields (set equality)', () => {
    const variants: Record<string, any> = {
      implementing: ImplementStageEntrySchema,
      spec_review: ReviewStageEntrySchema,
      quality_review: ReviewStageEntrySchema,
      diff_review: ReviewStageEntrySchema,
      spec_rework: ReworkStageEntrySchema,
      quality_rework: ReworkStageEntrySchema,
      verifying: VerifyStageEntrySchema,
      committing: CommitStageEntrySchema,
    };
    for (const [name, schema] of Object.entries(variants)) {
      const schemaKeys = new Set(Object.keys(schema.shape));
      schemaKeys.delete('name'); // discriminant, always populated
      const manifestKeys = new Set(Object.keys(STAGE_FIELD_COVERAGE[name as keyof typeof STAGE_FIELD_COVERAGE] ?? {}));
      expect(manifestKeys).toEqual(schemaKeys);
    }
  });

  it('every classification has the right shape', () => {
    const all = [
      ...Object.values(TASK_COMPLETED_FIELD_COVERAGE),
      ...Object.values(STAGE_FIELD_COVERAGE).flatMap(s => Object.values(s)),
    ];
    for (const c of all) {
      expect(['derived', 'constant', 'unavailable', 'not_applicable']).toContain(c.kind);
      if (c.kind === 'derived')      expect(typeof c.source).toBe('string');
      if (c.kind === 'constant')     expect(typeof c.reason).toBe('string');
      if (c.kind === 'unavailable')  { expect(typeof c.targetVersion).toBe('string'); expect(typeof c.reason).toBe('string'); }
      if (c.kind === 'not_applicable') expect(typeof c.reason).toBe('string');
    }
  });
});
