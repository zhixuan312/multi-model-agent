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

function combined(p: { systemPrefix: string; userBody: string }): string {
  return `${p.systemPrefix}\n\n${p.userBody}`;
}

describe('buildSpecReviewPrompt', () => {
  it('includes the execution packet in userBody', () => {
    const p = buildSpecReviewPrompt(packet, implReport, fileContents, toolCallLog);
    expect(p.userBody).toContain('Update auth to use JWT');
    expect(p.userBody).toContain('tsc passes');
  });
  it('includes the implementer structured report in userBody', () => {
    const p = buildSpecReviewPrompt(packet, implReport, fileContents, toolCallLog);
    expect(p.userBody).toContain('Swapped cookies for JWT');
    expect(p.userBody).toContain('src/auth/middleware.ts');
  });
  it('includes actual file contents in userBody', () => {
    const p = buildSpecReviewPrompt(packet, implReport, fileContents, toolCallLog);
    expect(p.userBody).toContain('import jwt from "jsonwebtoken"');
  });
  it('includes the tool-call log in userBody', () => {
    const p = buildSpecReviewPrompt(packet, implReport, fileContents, toolCallLog);
    expect(p.userBody).toContain('writeFile(src/auth/middleware.ts)');
  });
  it('instructs the reviewer in systemPrefix to return approved or changes_required', () => {
    const p = buildSpecReviewPrompt(packet, implReport, fileContents, toolCallLog);
    expect(p.systemPrefix).toContain('approved');
    expect(p.systemPrefix).toContain('changes_required');
  });
  it('includes completeness instruction in systemPrefix for partial edit detection', () => {
    const p = buildSpecReviewPrompt(packet, implReport, fileContents, toolCallLog);
    expect(p.systemPrefix).toContain('Completeness:');
    expect(p.systemPrefix).toContain('positive evidence of omission');
  });
});

describe('buildSpecReviewPrompt with planContext', () => {
  it('includes plan context section in userBody when planContext is provided', () => {
    const planContext = '### Task 3: Implement user auth\n\n- Create login/logout functions\n- Use JWT tokens';
    const p = buildSpecReviewPrompt(packet, implReport, fileContents, toolCallLog, planContext);
    expect(p.userBody).toContain('## Plan Context');
    expect(p.userBody).toContain('The implementation was driven by this plan section');
    expect(p.userBody).toContain('Create login/logout functions');
    expect(p.userBody).toContain('Use JWT tokens');
  });

  it('omits plan context section in userBody when planContext is undefined', () => {
    const p = buildSpecReviewPrompt(packet, implReport, fileContents, toolCallLog);
    expect(p.userBody).not.toContain('## Plan Context');
    expect(p.userBody).not.toContain('plan section');
  });

  it('omits plan context section when planContext is empty string', () => {
    const p = buildSpecReviewPrompt(packet, implReport, fileContents, toolCallLog, '');
    expect(p.userBody).not.toContain('## Plan Context');
  });

  it('still includes all standard sections when plan context is provided', () => {
    const planContext = '### Task 3: Auth\n\nDetails here.';
    const p = buildSpecReviewPrompt(packet, implReport, fileContents, toolCallLog, planContext);
    expect(p.userBody).toContain('## Execution Packet');
    expect(p.userBody).toContain('## Implementer Structured Report');
    expect(p.userBody).toContain('## Actual File Contents');
    expect(p.userBody).toContain('## Tool-Call Log');
    expect(p.systemPrefix).toContain('## Summary');
  });

  it('plan context appears before implementer report in userBody', () => {
    const planContext = '### Task 3: Auth\n\nDetails here.';
    const p = buildSpecReviewPrompt(packet, implReport, fileContents, toolCallLog, planContext);
    const planIdx = p.userBody.indexOf('## Plan Context');
    const reportIdx = p.userBody.indexOf('## Implementer Structured Report');
    expect(planIdx).toBeLessThan(reportIdx);
  });
});

describe('buildQualityReviewPrompt', () => {
  it('includes file contents in userBody for code review', () => {
    const p = buildQualityReviewPrompt(packet, implReport, fileContents, toolCallLog);
    expect(p.userBody).toContain('import jwt from "jsonwebtoken"');
  });
  it('instructs in systemPrefix to check error handling, edge cases, maintainability', () => {
    const p = buildQualityReviewPrompt(packet, implReport, fileContents, toolCallLog);
    expect(p.systemPrefix).toContain('error handling');
    expect(p.systemPrefix).toContain('edge cases');
  });
});
