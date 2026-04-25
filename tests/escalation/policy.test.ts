import { describe, it, expect } from 'vitest';
import {
  SPEC_LOOP_STANDARD,
  SPEC_LOOP_COMPLEX,
  QUALITY_LOOP_STANDARD,
  QUALITY_LOOP_COMPLEX,
  pickEscalation,
  pickReviewer,
  maxRowsFor,
  maxReworksFor,
} from '../../packages/core/src/escalation/policy.js';

describe('escalation/policy tables', () => {
  it('SPEC_LOOP_STANDARD = standard, standard, complex', () => {
    expect(SPEC_LOOP_STANDARD).toEqual([
      { impl: 'standard', reviewer: 'complex' },
      { impl: 'standard', reviewer: 'complex' },
      { impl: 'complex',  reviewer: 'standard' },
    ]);
  });

  it('QUALITY_LOOP_STANDARD = review-only, standard, complex', () => {
    expect(QUALITY_LOOP_STANDARD).toEqual([
      { impl: null,       reviewer: 'complex' },
      { impl: 'standard', reviewer: 'complex' },
      { impl: 'complex',  reviewer: 'standard' },
    ]);
  });

  it('SPEC_LOOP_COMPLEX is uniform complex/standard', () => {
    expect(SPEC_LOOP_COMPLEX).toEqual([
      { impl: 'complex', reviewer: 'standard' },
      { impl: 'complex', reviewer: 'standard' },
      { impl: 'complex', reviewer: 'standard' },
    ]);
  });

  it('QUALITY_LOOP_COMPLEX is review-only, complex, complex', () => {
    expect(QUALITY_LOOP_COMPLEX).toEqual([
      { impl: null,      reviewer: 'standard' },
      { impl: 'complex', reviewer: 'standard' },
      { impl: 'complex', reviewer: 'standard' },
    ]);
  });
});

describe('pickEscalation — implementation rows', () => {
  // 10 success cases: spec 0/1/2 × {standard, complex} = 6, quality 1/2 × {standard, complex} = 4

  it.each([
    [{ loop: 'spec' as const, attemptIndex: 0, baseTier: 'standard' as const }, { impl: 'standard', reviewer: 'complex', isEscalated: false }],
    [{ loop: 'spec' as const, attemptIndex: 1, baseTier: 'standard' as const }, { impl: 'standard', reviewer: 'complex', isEscalated: false }],
    [{ loop: 'spec' as const, attemptIndex: 2, baseTier: 'standard' as const }, { impl: 'complex',  reviewer: 'standard', isEscalated: true  }],
    [{ loop: 'spec' as const, attemptIndex: 0, baseTier: 'complex'  as const }, { impl: 'complex',  reviewer: 'standard', isEscalated: false }],
    [{ loop: 'spec' as const, attemptIndex: 1, baseTier: 'complex'  as const }, { impl: 'complex',  reviewer: 'standard', isEscalated: false }],
    [{ loop: 'spec' as const, attemptIndex: 2, baseTier: 'complex'  as const }, { impl: 'complex',  reviewer: 'standard', isEscalated: false }],
    [{ loop: 'quality' as const, attemptIndex: 1, baseTier: 'standard' as const }, { impl: 'standard', reviewer: 'complex', isEscalated: false }],
    [{ loop: 'quality' as const, attemptIndex: 2, baseTier: 'standard' as const }, { impl: 'complex',  reviewer: 'standard', isEscalated: true  }],
    [{ loop: 'quality' as const, attemptIndex: 1, baseTier: 'complex'  as const }, { impl: 'complex',  reviewer: 'standard', isEscalated: false }],
    [{ loop: 'quality' as const, attemptIndex: 2, baseTier: 'complex'  as const }, { impl: 'complex',  reviewer: 'standard', isEscalated: false }],
  ])('pickEscalation(%j) returns %j', (input, expected) => {
    expect(pickEscalation(input)).toEqual(expected);
  });
});

describe('pickEscalation — throw cases', () => {
  it('throws on quality index 0 (review-only row) for both base tiers', () => {
    expect(() => pickEscalation({ loop: 'quality', attemptIndex: 0, baseTier: 'standard' })).toThrow(/no impl row/);
    expect(() => pickEscalation({ loop: 'quality', attemptIndex: 0, baseTier: 'complex'  })).toThrow(/no impl row/);
  });

  it('throws on out-of-range index for both loops × both base tiers', () => {
    for (const loop of ['spec', 'quality'] as const) {
      for (const baseTier of ['standard', 'complex'] as const) {
        expect(() => pickEscalation({ loop, attemptIndex: 3, baseTier })).toThrow(/out of range/);
        expect(() => pickEscalation({ loop, attemptIndex: -1, baseTier })).toThrow(/out of range/);
      }
    }
  });
});

describe('pickReviewer — every row including review-only', () => {
  it.each([
    [{ loop: 'spec' as const, attemptIndex: 0, baseTier: 'standard' as const }, 'complex'],
    [{ loop: 'spec' as const, attemptIndex: 1, baseTier: 'standard' as const }, 'complex'],
    [{ loop: 'spec' as const, attemptIndex: 2, baseTier: 'standard' as const }, 'standard'],
    [{ loop: 'spec' as const, attemptIndex: 0, baseTier: 'complex'  as const }, 'standard'],
    [{ loop: 'spec' as const, attemptIndex: 1, baseTier: 'complex'  as const }, 'standard'],
    [{ loop: 'spec' as const, attemptIndex: 2, baseTier: 'complex'  as const }, 'standard'],
    [{ loop: 'quality' as const, attemptIndex: 0, baseTier: 'standard' as const }, 'complex'],
    [{ loop: 'quality' as const, attemptIndex: 1, baseTier: 'standard' as const }, 'complex'],
    [{ loop: 'quality' as const, attemptIndex: 2, baseTier: 'standard' as const }, 'standard'],
    [{ loop: 'quality' as const, attemptIndex: 0, baseTier: 'complex'  as const }, 'standard'],
    [{ loop: 'quality' as const, attemptIndex: 1, baseTier: 'complex'  as const }, 'standard'],
    [{ loop: 'quality' as const, attemptIndex: 2, baseTier: 'complex'  as const }, 'standard'],
  ])('pickReviewer(%j) === %s', (input, expected) => {
    expect(pickReviewer(input)).toBe(expected);
  });

  it('throws on out-of-range index', () => {
    expect(() => pickReviewer({ loop: 'spec', attemptIndex: 3, baseTier: 'standard' })).toThrow(/out of range/);
  });
});

describe('cap helpers', () => {
  it('maxRowsFor returns 3 for both loops', () => {
    expect(maxRowsFor('spec')).toBe(3);
    expect(maxRowsFor('quality')).toBe(3);
  });

  it('maxReworksFor returns 2 for both loops (loop-aware computation)', () => {
    expect(maxReworksFor('spec')).toBe(2);
    expect(maxReworksFor('quality')).toBe(2);
  });
});
