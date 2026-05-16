import { describe, it, expect } from 'vitest';
import { specReviewPrompt } from '../../packages/core/src/review/templates/spec-review.js';

describe('spec-review template', () => {
  it('assembled prompt contains the full output format with Verdict and Deviations sections', () => {
    const prompt = specReviewPrompt({
      brief: 'Test brief',
      workerSummary: 'Test summary',
      filesChanged: ['file-a.ts', 'file-b.ts'],
    });
    expect(prompt).toContain('## Verdict');
    expect(prompt).toContain('approved | changes_required');
    expect(prompt).toContain('## Deviations');
    expect(prompt).toContain('## Findings');
    expect(prompt).toContain('Severity:');
    expect(prompt).toContain('Category:');
    expect(prompt).toContain('Claim:');
    expect(prompt).toContain('Evidence:');
    expect(prompt).toContain('Suggestion:');
    expect(prompt).toContain('## Finding N:');
  });

  it('assembled prompt interpolates brief, workerSummary, and filesChanged', () => {
    const prompt = specReviewPrompt({
      brief: 'My task brief',
      workerSummary: 'What the worker did',
      filesChanged: ['src/foo.ts'],
    });
    expect(prompt).toContain('My task brief');
    expect(prompt).toContain('What the worker did');
    expect(prompt).toContain('src/foo.ts');
  });
});