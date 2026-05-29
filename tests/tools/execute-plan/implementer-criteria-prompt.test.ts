import { describe, it, expect } from 'bun:test';
import { SELF_VERIFICATION } from '../../../packages/core/src/tools/execute-plan/implementer-criteria.js';

describe('execute-plan implementer-criteria SELF_VERIFICATION prompt', () => {
  it('contains the new "verification is system\'s job" guidance', () => {
    expect(SELF_VERIFICATION).toMatch(/inability to verify is not.*failure/i);
    expect(SELF_VERIFICATION).toMatch(/system independently verifies/i);
  });

  it('no longer contains the "treat as incomplete" self-sabotage instruction', () => {
    expect(SELF_VERIFICATION).not.toMatch(/cannot run a command.*treat.*incomplete/i);
  });
});
