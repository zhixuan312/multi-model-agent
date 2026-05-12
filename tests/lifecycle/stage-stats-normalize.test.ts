import { describe, it, expect } from 'vitest';
import { normalizeLegacyStageLabel } from '../../packages/core/src/lifecycle/stage-labels.js';

describe('normalizeLegacyStageLabel', () => {
  it('collapses spec_review / quality_review / diff_review to review', () => {
    expect(normalizeLegacyStageLabel('spec_review')).toBe('review');
    expect(normalizeLegacyStageLabel('quality_review')).toBe('review');
    expect(normalizeLegacyStageLabel('diff_review')).toBe('review');
  });

  it('collapses any criterion_* label to implementing', () => {
    expect(normalizeLegacyStageLabel('criterion_1')).toBe('implementing');
    expect(normalizeLegacyStageLabel('criterion_audit_critical_severity')).toBe('implementing');
    expect(normalizeLegacyStageLabel('criterion_')).toBe('implementing');
  });

  it('maps annotating_retry to annotating', () => {
    expect(normalizeLegacyStageLabel('annotating_retry')).toBe('annotating');
  });

  it('passes through canonical wire labels unchanged', () => {
    for (const label of ['implementing', 'review', 'rework', 'committing', 'annotating']) {
      expect(normalizeLegacyStageLabel(label)).toBe(label);
    }
  });

  it('passes through unknown labels unchanged (caller decides handling)', () => {
    expect(normalizeLegacyStageLabel('finalizing')).toBe('finalizing');
    expect(normalizeLegacyStageLabel('something_new')).toBe('something_new');
  });
});
