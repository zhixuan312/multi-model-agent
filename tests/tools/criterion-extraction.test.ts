import { describe, it, expect } from 'vitest';
import { AUDIT_CRITERIA } from '../../packages/core/src/tools/audit/implementer-criteria.js';
import { REVIEW_CRITERIA } from '../../packages/core/src/tools/review/implementer-criteria.js';
import { VERIFY_CRITERIA } from '../../packages/core/src/tools/verify/implementer-criteria.js';
import { DEBUG_CRITERIA } from '../../packages/core/src/tools/debug/implementer-criteria.js';
import { INVESTIGATE_CRITERIA } from '../../packages/core/src/tools/investigate/implementer-criteria.js';

describe('per-route criterion arrays', () => {
  const cases = [
    { name: 'audit', arr: AUDIT_CRITERIA, expectedN: 11 },
    { name: 'review', arr: REVIEW_CRITERIA, expectedN: 10 },
    { name: 'verify', arr: VERIFY_CRITERIA, expectedN: 5 },
    { name: 'debug', arr: DEBUG_CRITERIA, expectedN: 5 },
    { name: 'investigate', arr: INVESTIGATE_CRITERIA, expectedN: 8 },
  ];
  it.each(cases)('$name has $expectedN well-formed criteria', ({ arr, expectedN }) => {
    expect(arr).toHaveLength(expectedN);
    arr.forEach((c, i) => {
      expect(c.id).toBe(String(i + 1));
      expect(c.title.length).toBeGreaterThan(0);
      expect(c.description.length).toBeGreaterThan(20);
    });
  });

  it('audit criteria #1 is RECOMMENDATION-COHERENCE', () => {
    expect(AUDIT_CRITERIA[0].title).toContain('RECOMMENDATION-COHERENCE');
  });

  it('investigate criteria #3 is HALLUCINATED CITATION (about file:line that does not exist)', () => {
    expect(INVESTIGATE_CRITERIA[2].title).toContain('HALLUCINATED CITATION');
    expect(INVESTIGATE_CRITERIA[2].description).toMatch(/file:line/i);
  });
});
