import { describe, it, expect } from 'vitest';
import { specReviewPrompt } from '../../../packages/core/src/lifecycle/handlers/spec-review-prompt.js';

describe('specReviewPrompt', () => {
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

  it('renders authoritative diff section when diff is provided', () => {
    const diffContent = 'diff --git a/file.ts b/file.ts\n--- a/file.ts\n+++ b/file.ts';
    const prompt = specReviewPrompt({
      brief: 'Test brief',
      workerSummary: 'Test summary',
      filesChanged: [],
      diff: diffContent,
    });
    expect(prompt).toContain('Diff (authoritative — what actually changed on disk):');
    expect(prompt).toContain(diffContent);
  });

  it('renders placeholder when diff is empty', () => {
    const prompt = specReviewPrompt({
      brief: 'Test brief',
      workerSummary: 'Test summary',
      filesChanged: [],
      diff: '',
    });
    expect(prompt).toContain('Diff (authoritative — what actually changed on disk):');
    expect(prompt).toContain('(no diff available)');
  });

  it('renders placeholder when diff is not provided', () => {
    const prompt = specReviewPrompt({
      brief: 'Test brief',
      workerSummary: 'Test summary',
      filesChanged: [],
    });
    expect(prompt).toContain('Diff (authoritative — what actually changed on disk):');
    expect(prompt).toContain('(no diff available)');
  });

  it('renders guardrail rule 1: do not claim files missing/untracked', () => {
    const prompt = specReviewPrompt({
      brief: 'Test brief',
      workerSummary: 'Test summary',
      filesChanged: [],
      diff: 'some diff',
    });
    expect(prompt).toContain('do NOT claim files missing/untracked');
  });

  it('renders guardrail rule 2: test status from Worker, do not infer from diff', () => {
    const prompt = specReviewPrompt({
      brief: 'Test brief',
      workerSummary: 'Test summary',
      filesChanged: [],
      diff: 'some diff',
    });
    expect(prompt).toContain('test status is in Worker said; don\'t infer skipped from diff');
  });

  it('renders pre-truncated diff with marker', () => {
    const preTruncatedDiff = 'diff content here\n[diff truncated]';
    const prompt = specReviewPrompt({
      brief: 'Test brief',
      workerSummary: 'Test summary',
      filesChanged: [],
      diff: preTruncatedDiff,
    });
    expect(prompt).toContain('[diff truncated]');
    expect(prompt).toContain('diff content here');
  });
});