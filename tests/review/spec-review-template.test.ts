import { describe, it, expect } from 'vitest';
import { specReviewPrompt, legalOutcomes } from '../../packages/core/src/review/templates/spec-review.js';

describe('spec-review template', () => {
  it('assembled prompt contains canonical format with Verdict, Findings, and Outcome sections', () => {
    const prompt = specReviewPrompt({
      brief: 'Test brief',
      workerSummary: 'Test summary',
      filesChanged: ['file-a.ts', 'file-b.ts'],
    });
    expect(prompt).toContain('## Verdict');
    expect(prompt).toContain('approved | changes_required');
    expect(prompt).toContain('## Findings');
    expect(prompt).toContain('## Outcome');
    expect(prompt).toContain('found | clean');
    expect(prompt).toContain('- Severity:');
    expect(prompt).toContain('- Category:');
    expect(prompt).toContain('- Evidence:');
    expect(prompt).toContain('- Suggestion:');
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

  it('exports legalOutcomes constant', () => {
    expect(legalOutcomes).toEqual(['found', 'clean']);
  });

  it('prompt includes all four severity definitions verbatim', () => {
    const prompt = specReviewPrompt({
      brief: 'Test brief',
      workerSummary: 'Test summary',
      filesChanged: [],
    });
    // Each severity definition from spec §9 must appear exactly as specified
    expect(prompt).toContain('critical:');
    expect(prompt).toContain('high:');
    expect(prompt).toContain('medium:');
    expect(prompt).toContain('low:');
    // Verify the exact severity definition lines
    expect(prompt).toContain('Plan step missed/wrong such that feature won\'t work');
    expect(prompt).toContain('Plan step partially implemented');
    expect(prompt).toContain('Diverges in non-essential ways');
    expect(prompt).toContain('Cosmetic drift');
  });
});