import { describe, it, expect } from 'vitest';
import { reworkTemplate } from '../../packages/core/src/review/templates/rework.js';

describe('rework prompt', () => {
  it('contains the new "verification is reviewer\'s responsibility" sentence', () => {
    // The sentence was added to the systemPrompt block, not buildUserPrompt.
    expect(reworkTemplate.systemPrompt).toMatch(/verification.*reviewer's responsibility/i);
  });
});
