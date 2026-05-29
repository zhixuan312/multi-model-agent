import { describe, it, expect } from 'bun:test';
import { HUMAN_LABEL, WIRE_LABEL, STAGE_LABELS, type StageLabel } from '../../packages/core/src/lifecycle/stage-labels.js';

describe('stage labels', () => {
  it('exports the five canonical labels', () => {
    expect([...STAGE_LABELS].sort()).toEqual(['annotating', 'committing', 'implementing', 'review', 'rework']);
  });
  it('round-trips human ↔ wire', () => {
    expect(WIRE_LABEL.Implementing).toBe('implementing');
    expect(HUMAN_LABEL.implementing).toBe('Implementing');
    expect(HUMAN_LABEL.review).toBe('Review');
    expect(HUMAN_LABEL.rework).toBe('Rework');
    expect(HUMAN_LABEL.committing).toBe('Committing');
    expect(HUMAN_LABEL.annotating).toBe('Annotating');
  });
  it('STAGE_LABELS is readonly typed', () => {
    const sample: StageLabel = 'implementing';
    expect(STAGE_LABELS).toContain(sample);
  });
});
