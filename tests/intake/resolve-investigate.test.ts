import { OUTPUT_CONTRACT_CLAUSES, ROUTE_DEFAULTS } from '../../packages/core/src/intake/resolve.js';

describe('resolve.ts — investigate_codebase entries', () => {
  it('OUTPUT_CONTRACT_CLAUSES includes investigate_codebase', () => {
    expect(OUTPUT_CONTRACT_CLAUSES['investigate_codebase']).toMatch(/findings/);
  });

  it('ROUTE_DEFAULTS for investigate_codebase = complex slot, quality_only review', () => {
    expect(ROUTE_DEFAULTS['investigate_codebase']).toEqual({
      agentType: 'complex',
      reviewPolicy: 'quality_only',
    });
  });
});