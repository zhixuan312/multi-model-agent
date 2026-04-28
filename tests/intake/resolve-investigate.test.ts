import { OUTPUT_CONTRACT_CLAUSES, ROUTE_DEFAULTS } from '../../packages/core/src/intake/resolve.js';

describe('resolve.ts — investigate_codebase entries', () => {
  it('OUTPUT_CONTRACT_CLAUSES includes investigate_codebase with new evidence-based shape', () => {
    const clause = OUTPUT_CONTRACT_CLAUSES['investigate_codebase']!;
    expect(clause).toMatch(/findings\[\]/);
    expect(clause).toMatch(/`evidence`/);
    expect(clause).toMatch(/at least 20 characters/);
    expect(clause).toMatch(/`suggestion\?`/);
    // Old fields gone
    expect(clause).not.toMatch(/sourceQuote/);
    expect(clause).not.toMatch(/`file`.*`line`/);
    expect(clause).not.toMatch(/suggestedFix/);
  });

  it('ROUTE_DEFAULTS for investigate_codebase = complex slot, quality_only review', () => {
    expect(ROUTE_DEFAULTS['investigate_codebase']).toEqual({
      agentType: 'complex',
      reviewPolicy: 'quality_only',
    });
  });
});