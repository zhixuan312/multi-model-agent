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

  it('renders authoritative diff section when diff is provided', () => {
    const diffContent = 'diff --git a/file.ts b/file.ts\n--- a/file.ts\n+++ b/file.ts';
    const prompt = qualityReviewPrompt({
      brief: 'do x', workerSummary: 'did x', filesChanged: ['a.ts'], diff: diffContent,
    });
    expect(prompt).toContain('Diff (authoritative — what actually changed on disk):');
    expect(prompt).toContain(diffContent);
  });

  it('renders placeholder when diff is empty', () => {
    const prompt = qualityReviewPrompt({
      brief: 'do x', workerSummary: 'did x', filesChanged: ['a.ts'], diff: '',
    });
    expect(prompt).toContain('Diff (authoritative — what actually changed on disk):');
    expect(prompt).toContain('(no diff available)');
  });

  it('renders placeholder when diff is not provided', () => {
    const prompt = qualityReviewPrompt({
      brief: 'do x', workerSummary: 'did x', filesChanged: ['a.ts'],
    });
    expect(prompt).toContain('Diff (authoritative — what actually changed on disk):');
    expect(prompt).toContain('(no diff available)');
  });

  it('renders guardrail rule 1: do not claim files missing/untracked', () => {
    const prompt = qualityReviewPrompt({
      brief: 'do x', workerSummary: 'did x', filesChanged: ['a.ts'], diff: 'some diff',
    });
    expect(prompt).toContain('do NOT claim files missing/untracked');
  });

  it('renders guardrail rule 2: test status from Worker, do not infer from diff', () => {
    const prompt = qualityReviewPrompt({
      brief: 'do x', workerSummary: 'did x', filesChanged: ['a.ts'], diff: 'some diff',
    });
    expect(prompt).toContain('test status is in Worker said; don\'t infer skipped from diff');
  });

  it('renders pre-truncated diff with marker', () => {
    const preTruncatedDiff = 'diff content here\n[diff truncated]';
    const prompt = qualityReviewPrompt({
      brief: 'do x', workerSummary: 'did x', filesChanged: ['a.ts'], diff: preTruncatedDiff,
    });
    expect(prompt).toContain('[diff truncated]');
    expect(prompt).toContain('diff content here');
  });
});