import { describe, it, expect } from 'vitest';
import {
  buildSpecReviewPrompt,
  buildQualityReviewPrompt,
  type ReviewPromptParts,
} from '../../packages/core/src/review/reviewer-prompt.js';
import type { ParsedStructuredReport } from '../../packages/core/src/reporting/structured-report.js';

function mockReport(): ParsedStructuredReport {
  return {
    summary: 'Implemented Task 42',
    filesChanged: [{ path: 'src/foo.ts', summary: 'added foo' }],
    validationsRun: [{ command: 'npm test', result: 'passed' }],
    deviationsFromBrief: [],
    unresolved: [],
    directive: { verdict: 'done', reason: '' },
  };
}

function mockPacket() {
  return {
    prompt: 'Add a foo function to src/foo.ts',
    scope: ['src/foo.ts'],
    doneCondition: 'file exists and tests pass',
  };
}

describe('Item 4: reviewer prompt restructure', () => {
  it('buildSpecReviewPrompt returns {systemPrefix, userBody}', () => {
    const parts = buildSpecReviewPrompt(
      mockPacket(),
      mockReport(),
      { 'src/foo.ts': 'export function foo() {}' },
      ['read_file: src/foo.ts', 'write_file: src/foo.ts'],
    );

    expect(parts).toHaveProperty('systemPrefix');
    expect(parts).toHaveProperty('userBody');
    expect(typeof parts.systemPrefix).toBe('string');
    expect(typeof parts.userBody).toBe('string');
  });

  it('systemPrefix contains rubric and task instructions (stable content)', () => {
    const parts = buildSpecReviewPrompt(
      mockPacket(),
      mockReport(),
      { 'src/foo.ts': 'export function foo() {}' },
      ['read_file: src/foo.ts'],
    );

    expect(parts.systemPrefix).toContain('spec compliance reviewer');
    expect(parts.systemPrefix).toContain('## Summary');
    expect(parts.systemPrefix).toContain('## Deviations from brief');
  });

  it('userBody contains execution packet and evidence (variable content)', () => {
    const parts = buildSpecReviewPrompt(
      mockPacket(),
      mockReport(),
      { 'src/foo.ts': 'export function foo() {}' },
      ['read_file: src/foo.ts'],
    );

    expect(parts.userBody).toContain('## Execution Packet');
    expect(parts.userBody).toContain('Add a foo function');
    expect(parts.userBody).toContain('## Implementer Structured Report');
    expect(parts.userBody).toContain('## Actual File Contents');
    expect(parts.userBody).toContain('## Tool-Call Log');
  });

  it('variable evidence does NOT leak into systemPrefix', () => {
    const parts = buildSpecReviewPrompt(
      mockPacket(),
      mockReport(),
      { 'src/foo.ts': 'export function foo() {}' },
      ['read_file: src/foo.ts'],
    );

    expect(parts.systemPrefix).not.toContain('## Execution Packet');
    expect(parts.systemPrefix).not.toContain('## Actual File Contents');
    expect(parts.systemPrefix).not.toContain('## Tool-Call Log');
    expect(parts.systemPrefix).not.toContain('export function foo()');
  });

  it('buildSpecReviewPrompt injects plan context into userBody when provided', () => {
    const planCtx = '## Plan Section 3\nImplement the foo function.';
    const parts = buildSpecReviewPrompt(
      mockPacket(),
      mockReport(),
      {},
      [],
      planCtx,
    );

    expect(parts.userBody).toContain('## Plan Context');
    expect(parts.userBody).toContain('Implement the foo function');
    expect(parts.systemPrefix).not.toContain('## Plan Context');
  });
});

describe('Item 4: quality review prompt restructure', () => {
  it('buildQualityReviewPrompt returns {systemPrefix, userBody}', () => {
    const parts = buildQualityReviewPrompt(
      mockPacket(),
      mockReport(),
      { 'src/foo.ts': 'export function foo() {}' },
      ['read_file: src/foo.ts'],
    );

    expect(parts).toHaveProperty('systemPrefix');
    expect(parts).toHaveProperty('userBody');
  });

  it('systemPrefix contains rubric, userBody contains evidence', () => {
    const parts = buildQualityReviewPrompt(
      mockPacket(),
      mockReport(),
      { 'src/foo.ts': 'export function foo() {}' },
      ['read_file: src/foo.ts'],
    );

    expect(parts.systemPrefix).toContain('code quality reviewer');
    expect(parts.systemPrefix).toContain('error handling gaps');
    expect(parts.userBody).toContain('## Execution Packet');
    expect(parts.userBody).toContain('## Actual File Contents');
  });
});

describe('Item 4: ReviewPromptParts type shape', () => {
  it('ReviewPromptParts has systemPrefix: string and userBody: string', () => {
    const parts: ReviewPromptParts = {
      systemPrefix: 'rubric',
      userBody: 'evidence',
    };
    expect(parts.systemPrefix).toBe('rubric');
    expect(parts.userBody).toBe('evidence');
  });
});
