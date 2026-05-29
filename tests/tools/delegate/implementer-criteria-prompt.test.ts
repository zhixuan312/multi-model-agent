import { describe, it, expect } from 'bun:test';
import { WORKER_SELF_ASSESSMENT_DELEGATE } from '../../../packages/core/src/tools/delegate/implementer-criteria.js';

describe('delegate WORKER_SELF_ASSESSMENT_DELEGATE prompt', () => {
  it('contains explicit worker self-assessment guidance', () => {
    expect(WORKER_SELF_ASSESSMENT_DELEGATE).toMatch(/done.*requested code changes are complete/i);
    expect(WORKER_SELF_ASSESSMENT_DELEGATE).toMatch(/inability to.{0,20}verify.{0,30}not.{0,10}failure/i);
  });
});
