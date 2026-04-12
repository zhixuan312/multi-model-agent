import { describe, it, expect } from 'vitest';
import { buildSpecReviewPrompt, buildQualityReviewPrompt } from '@zhixuan92/multi-model-agent-core/review/reviewer-prompt';
import type { ParsedStructuredReport } from '@zhixuan92/multi-model-agent-core';

const packet = {
  normalizedPrompt: 'Update auth to use JWT. Done when tsc passes.',
  scope: ['src/auth/middleware.ts'],
  doneCondition: 'tsc passes',
};

const implReport: ParsedStructuredReport = {
  summary: 'Swapped cookies for JWT.',
  filesChanged: [{ path: 'src/auth/middleware.ts', summary: 'JWT implementation' }],
  normalizationDecisions: [],
  validationsRun: [{ command: 'tsc', result: 'passed' }],
  deviationsFromBrief: [],
  unresolved: [],
};

const fileContents = { 'src/auth/middleware.ts': 'import jwt from "jsonwebtoken";\n// ... 50 lines' };
const toolCallLog = ['readFile(src/auth/middleware.ts)', 'writeFile(src/auth/middleware.ts)'];

describe('buildSpecReviewPrompt', () => {
  it('includes the execution packet', () => {
    const p = buildSpecReviewPrompt(packet, implReport, fileContents, toolCallLog);
    expect(p).toContain('Update auth to use JWT');
    expect(p).toContain('tsc passes');
  });
  it('includes the implementer structured report', () => {
    const p = buildSpecReviewPrompt(packet, implReport, fileContents, toolCallLog);
    expect(p).toContain('Swapped cookies for JWT');
    expect(p).toContain('src/auth/middleware.ts');
  });
  it('includes actual file contents', () => {
    const p = buildSpecReviewPrompt(packet, implReport, fileContents, toolCallLog);
    expect(p).toContain('import jwt from "jsonwebtoken"');
  });
  it('includes the tool-call log', () => {
    const p = buildSpecReviewPrompt(packet, implReport, fileContents, toolCallLog);
    expect(p).toContain('writeFile(src/auth/middleware.ts)');
  });
  it('instructs the reviewer to return approved or changes_required', () => {
    const p = buildSpecReviewPrompt(packet, implReport, fileContents, toolCallLog);
    expect(p).toContain('approved');
    expect(p).toContain('changes_required');
  });
});

describe('buildQualityReviewPrompt', () => {
  it('includes file contents for code review', () => {
    const p = buildQualityReviewPrompt(packet, implReport, fileContents, toolCallLog);
    expect(p).toContain('import jwt from "jsonwebtoken"');
  });
  it('instructs to check error handling, edge cases, maintainability', () => {
    const p = buildQualityReviewPrompt(packet, implReport, fileContents, toolCallLog);
    expect(p).toContain('error handling');
    expect(p).toContain('edge cases');
  });
});