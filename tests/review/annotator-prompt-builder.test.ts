import { describe, it, expect } from 'vitest';
import {
  trimBriefForAnnotator,
  assembleAnnotatorPrompt,
} from '../../packages/core/src/review/annotator-prompt-builder.js';

// Tool sweep #11: keep the annotator's view of the brief tight by
// trimming the format-spec sections (which are duplicated by
// ANNOTATOR_RUBRIC below). Saves 1-3KB context per call.

describe('trimBriefForAnnotator', () => {
  it('keeps everything before "Produce a narrative ... report" marker (audit)', () => {
    const brief = `Audit for security issues.

Read and analyze this file:
- src/auth.ts

Produce a narrative audit report. Use this EXACT per-finding format — both the structured reviewer and the deterministic fallback extract from this same format:

## Finding 1: <one-line title>
- Severity: critical | high | medium | low
- ...`;
    const out = trimBriefForAnnotator(brief);
    expect(out).toContain('Audit for security issues.');
    expect(out).toContain('Read and analyze this file:');
    expect(out).not.toContain('## Finding 1:');
    expect(out).not.toContain('Produce a narrative audit report');
  });

  it('strips at "## Finding 1:" marker (verify / review)', () => {
    const brief = `Verify this work:

Checklist:
1. handler returns 200
2. cookies are set

## Finding 1: <criterion summary>
- Severity: low
- Item: ...`;
    const out = trimBriefForAnnotator(brief);
    expect(out).toContain('Checklist:');
    expect(out).toContain('cookies are set');
    expect(out).not.toContain('## Finding 1:');
  });

  it('strips at "Use hypothesis-driven debugging" marker (debug)', () => {
    const brief = `Debug this problem:

The handler crashes on empty input.

Use hypothesis-driven debugging. Use this EXACT per-finding format`;
    const out = trimBriefForAnnotator(brief);
    expect(out).toContain('crashes on empty input');
    expect(out).not.toContain('Use hypothesis-driven');
  });

  it('extracts `Question: ...` line for investigate shape (spec-first)', () => {
    const brief = `Produce an investigation report in this EXACT structured format. The deterministic parser ...
... (format spec body) ...

Anchor paths to start from (you may also read beyond these):
- src/auth.ts

Question: How does the auth-token rule work?`;
    expect(trimBriefForAnnotator(brief)).toBe('Question: How does the auth-token rule work?');
  });

  it('passes through brief that has no format-spec marker', () => {
    const brief = 'Just a short brief with no format spec.';
    expect(trimBriefForAnnotator(brief)).toBe(brief);
  });

  it('returns empty / whitespace input unchanged', () => {
    expect(trimBriefForAnnotator('')).toBe('');
    expect(trimBriefForAnnotator(undefined as unknown as string)).toBe(undefined as unknown as string);
  });
});

describe('assembleAnnotatorPrompt', () => {
  it('uses the trimmed brief in the assembled prompt', () => {
    const template = {
      role: 'audit',
      onBriefCheck: 'For each finding, ask: ...',
    };
    const ctx = {
      brief: 'Audit for security issues.\n\nRead and analyze this file:\n- src/x.ts\n\nProduce a narrative audit report. ## Finding 1:',
      workerOutput: '## Finding 1: bug\n- Severity: high',
    };
    const prompt = assembleAnnotatorPrompt(template, ctx);
    // Brief section should NOT contain the format spec
    expect(prompt).toContain('Audit for security issues.');
    // The format spec line gets trimmed from the BRIEF — but the rubric
    // (appended below) does mention `## Finding 1:` as an example of
    // worker findings the annotator extracts. The crucial thing is the
    // brief block above the rubric doesn't carry the spec.
    const briefSection = prompt.split('## On-brief check')[0];
    expect(briefSection).not.toContain('Produce a narrative audit report');
    expect(briefSection).not.toContain('## Finding 1:');
    // Worker output should still be present.
    expect(prompt).toContain('## Worker output to extract findings from');
    expect(prompt).toContain('## Finding 1: bug');
    // Rubric appended.
    expect(prompt).toContain('## Output format');
  });
});
