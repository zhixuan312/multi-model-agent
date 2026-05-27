import { describe, it, expect } from 'vitest';
import { FINDING_FORMAT_SHARED } from '../../packages/core/src/routing/read-route-criteria.js';

describe('FINDING_FORMAT_SHARED — canonical format', () => {
  it('includes canonical heading + 4 mandatory bullets', () => {
    expect(FINDING_FORMAT_SHARED).toContain('## Finding N:');
    expect(FINDING_FORMAT_SHARED).toContain('- Severity:');
    expect(FINDING_FORMAT_SHARED).toContain('- Category:');
    expect(FINDING_FORMAT_SHARED).toContain('- Evidence:');
    expect(FINDING_FORMAT_SHARED).toContain('- Suggestion:');
  });
  it('includes ## Outcome section with the three legal values', () => {
    expect(FINDING_FORMAT_SHARED).toContain('## Outcome');
    expect(FINDING_FORMAT_SHARED).toMatch(/found.*clean.*not_applicable/s);
  });
  it('includes investigate-specific Evidence rule', () => {
    expect(FINDING_FORMAT_SHARED).toMatch(/investigate.*Evidence.*file:line/is);
  });
});
