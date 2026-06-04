import { describe, it, expect } from 'vitest';
import { notApplicableSchema, type NotApplicable } from '@zhixuan92/multi-model-agent-core';

describe('NotApplicable sentinel', () => {
  it('parses a valid sentinel', () => {
    const v: NotApplicable = { kind: 'not_applicable', reason: 'test' };
    expect(notApplicableSchema.parse(v)).toEqual(v);
  });

  it('rejects empty reason', () => {
    expect(() => notApplicableSchema.parse({ kind: 'not_applicable', reason: '' })).toThrow();
  });

  it('rejects wrong kind', () => {
    expect(() => notApplicableSchema.parse({ kind: 'other', reason: 'x' })).toThrow();
  });
});
