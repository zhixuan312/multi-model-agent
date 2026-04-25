import { OUTPUT_CONTRACT_CLAUSES, ROUTE_DEFAULTS } from '../../packages/core/src/intake/resolve.js';

describe('resolve.ts — investigate_codebase entries', () => {
  it('OUTPUT_CONTRACT_CLAUSES includes investigate_codebase', () => {
    expect(OUTPUT_CONTRACT_CLAUSES['investigate_codebase']).toMatch(/file:line/);
    expect(OUTPUT_CONTRACT_CLAUSES['investigate_codebase']).toMatch(/confidence/i);
  });

  it('ROUTE_DEFAULTS for investigate_codebase = complex slot, off review', () => {
    expect(ROUTE_DEFAULTS['investigate_codebase']).toEqual({
      agentType: 'complex',
      reviewPolicy: 'off',
    });
  });
});