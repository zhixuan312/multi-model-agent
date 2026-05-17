import { describe, it, expect } from 'vitest';
import { qualityReviewPrompt, legalOutcomes } from '../../packages/core/src/review/templates/quality-review.js';

describe('quality-review template', () => {
  it('prompt asks for canonical format with ## Finding N: blocks and ## Outcome section', () => {
    const prompt = qualityReviewPrompt({
      brief: 'do x', workerSummary: 'did x', filesChanged: ['a.ts'],
    });
    expect(prompt).toMatch(/## Finding N:/);
    expect(prompt).toContain('## Outcome');
    expect(prompt).toContain('found | clean');
    expect(prompt).not.toMatch(/## Deviations/);
  });

  it('uses Evidence field (not Issue)', () => {
    const prompt = qualityReviewPrompt({
      brief: 'do x', workerSummary: 'did x', filesChanged: ['a.ts'],
    });
    expect(prompt).toContain('- Evidence:');
    expect(prompt).not.toContain('- Issue:');
  });

  it('exports legalOutcomes constant', () => {
    expect(legalOutcomes).toEqual(['found', 'clean']);
  });

  it('prompt includes severity definitions verbatim', () => {
    const prompt = qualityReviewPrompt({
      brief: 'do x', workerSummary: 'did x', filesChanged: ['a.ts'],
    });
    expect(prompt).toContain('Will break in production');
    expect(prompt).toContain('Correctness gap in normal use');
    expect(prompt).toContain('Maintainability/fragility');
    expect(prompt).toContain('Style');
  });
});