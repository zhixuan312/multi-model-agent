import { describe, it, expect } from 'vitest';
import { InvestigationConfidenceEnum, FindingConfidenceSchema } from '../../packages/core/src/events/event-base.js';

describe('confidence enums', () => {
  it('investigation accepts low/medium/high', () => {
    for (const v of ['low', 'medium', 'high'] as const) {
      expect(() => InvestigationConfidenceEnum.parse(v)).not.toThrow();
    }
  });
  it('finding accepts integer 0..100', () => {
    expect(() => FindingConfidenceSchema.parse(0)).not.toThrow();
    expect(() => FindingConfidenceSchema.parse(100)).not.toThrow();
    expect(() => FindingConfidenceSchema.parse(101)).toThrow();
    expect(() => FindingConfidenceSchema.parse(50.5)).toThrow();
    expect(() => FindingConfidenceSchema.parse(-1)).toThrow();
  });
});
