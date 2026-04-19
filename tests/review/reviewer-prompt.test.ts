import { describe, it, expect } from 'vitest';
import { buildSpecReviewPrompt, buildQualityReviewPrompt } from '@zhixuan92/multi-model-agent-core/review/reviewer-prompt';
import type { ParsedStructuredReport } from '@zhixuan92/multi-model-agent-core';

const packet = {
  prompt: 'Update auth to use JWT. Done when tsc passes.',
  scope: ['src/auth/middleware.ts'],
  doneCondition: 'tsc passes',
};

const implReport: ParsedStructuredReport = {
  summary: 'Swapped cookies for JWT.',
  filesChanged: [{ path: 'src/auth/middleware.ts', summary: 'JWT implementation' }],
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

  it('includes completeness instruction for partial edit detection', () => {
    const p = buildSpecReviewPrompt(packet, implReport, fileContents, toolCallLog);
    expect(p).toContain('Completeness:');
    expect(p).toContain('positive evidence of omission');
    expect(p).toContain('changes_required');
  });
});

describe('buildSpecReviewPrompt with planContext', () => {
  it('includes plan context section when planContext is provided', () => {
    const planContext = '### Task 3: Implement user auth\n\n- Create login/logout functions\n- Use JWT tokens';
    const p = buildSpecReviewPrompt(packet, implReport, fileContents, toolCallLog, planContext);
    expect(p).toContain('## Plan Context');
    expect(p).toContain('The implementation was driven by this plan section');
    expect(p).toContain('Create login/logout functions');
    expect(p).toContain('Use JWT tokens');
  });

  it('omits plan context section when planContext is undefined', () => {
    const p = buildSpecReviewPrompt(packet, implReport, fileContents, toolCallLog);
    expect(p).not.toContain('## Plan Context');
    expect(p).not.toContain('plan section');
  });

  it('omits plan context section when planContext is empty string', () => {
    const p = buildSpecReviewPrompt(packet, implReport, fileContents, toolCallLog, '');
    expect(p).not.toContain('## Plan Context');
  });

  it('still includes all standard sections when plan context is provided', () => {
    const planContext = '### Task 3: Auth\n\nDetails here.';
    const p = buildSpecReviewPrompt(packet, implReport, fileContents, toolCallLog, planContext);
    expect(p).toContain('## Execution Packet');
    expect(p).toContain('## Implementer Structured Report');
    expect(p).toContain('## Actual File Contents');
    expect(p).toContain('## Tool-Call Log');
    expect(p).toContain('## Your Task');
  });

  it('plan context appears before implementer report', () => {
    const planContext = '### Task 3: Auth\n\nDetails here.';
    const p = buildSpecReviewPrompt(packet, implReport, fileContents, toolCallLog, planContext);
    const planIdx = p.indexOf('## Plan Context');
    const reportIdx = p.indexOf('## Implementer Structured Report');
    expect(planIdx).toBeLessThan(reportIdx);
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