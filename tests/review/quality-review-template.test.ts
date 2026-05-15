import { describe, it, expect } from 'vitest';
import { qualityReviewPrompt } from '../../packages/core/src/review/templates/quality-review.js';

describe('quality-review template', () => {
  it('prompt asks for ## Finding N: blocks', () => {
    const prompt = qualityReviewPrompt({
      brief: 'do x', workerSummary: 'did x', filesChanged: ['a.ts'],
    });
    expect(prompt).toMatch(/## Finding N:/);
    expect(prompt).not.toMatch(/## Deviations/);
  });
});