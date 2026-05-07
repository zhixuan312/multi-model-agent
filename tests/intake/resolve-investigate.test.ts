import { OUTPUT_CONTRACT_CLAUSES } from '../../packages/core/src/intake/resolve.js';
import { ROUTE_DEFAULTS } from '../../packages/core/src/intake/field-inferer.js';

describe('resolve.ts — investigate_codebase entries', () => {
  it('OUTPUT_CONTRACT_CLAUSES does NOT include investigate_codebase', () => {
    expect(OUTPUT_CONTRACT_CLAUSES['investigate_codebase']).toBeUndefined();
  });

  it('ROUTE_DEFAULTS for investigate_codebase = complex slot, quality_only review', () => {
    expect(ROUTE_DEFAULTS['investigate_codebase']).toEqual({
      agentType: 'complex',
      reviewPolicy: 'quality_only',
    });
  });
});