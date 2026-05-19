import { describe, it, expect } from 'vitest';
import { qualityReviewPrompt } from '../../../packages/core/src/lifecycle/handlers/quality-review-prompt.js';

describe('qualityReviewPrompt', () => {
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

  it('prompt includes all four severity definitions verbatim', () => {
    const prompt = qualityReviewPrompt({
      brief: 'do x', workerSummary: 'did x', filesChanged: ['a.ts'],
    });
    // Each severity definition from spec §9 must appear exactly as specified
    expect(prompt).toContain('critical:');
    expect(prompt).toContain('high:');
    expect(prompt).toContain('medium:');
    expect(prompt).toContain('low:');
    // Verify the exact severity definition lines for quality-review
    expect(prompt).toContain('Will break in production');
    expect(prompt).toContain('Correctness gap in normal use');
    expect(prompt).toContain('Maintainability/fragility');
    expect(prompt).toContain('Style');
  });
});