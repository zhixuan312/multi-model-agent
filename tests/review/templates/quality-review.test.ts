import { describe, it, expect } from 'vitest';
import { qualityLintTemplate } from '../../../packages/core/src/review/templates/quality-review.js';

const ctx = {
  workerOutput: 'IMPLEMENTER_OUTPUT_BODY_SENTINEL_43891',
  brief: 'BRIEF_BODY_SENTINEL_77123',
  diff: 'DIFF_BODY_SENTINEL_29348',
  planContext: 'PLAN_CONTEXT_SENTINEL_55421',
};

describe('qualityLintTemplate.buildWarmFollowup', () => {
  it('is exported as a function', () => {
    expect(typeof qualityLintTemplate.buildWarmFollowup).toBe('function');
  });

  it('does NOT include the brief body', () => {
    const out = qualityLintTemplate.buildWarmFollowup!(ctx);
    expect(out).not.toContain('BRIEF_BODY_SENTINEL_77123');
  });

  it('does NOT include the worker output body', () => {
    const out = qualityLintTemplate.buildWarmFollowup!(ctx);
    expect(out).not.toContain('IMPLEMENTER_OUTPUT_BODY_SENTINEL_43891');
  });

  it('does NOT include the diff body', () => {
    const out = qualityLintTemplate.buildWarmFollowup!(ctx);
    expect(out).not.toContain('DIFF_BODY_SENTINEL_29348');
  });

  it('does NOT include the planContext body', () => {
    const out = qualityLintTemplate.buildWarmFollowup!(ctx);
    expect(out).not.toContain('PLAN_CONTEXT_SENTINEL_55421');
  });

  it('DOES emit the quality criteria action and the verdict format', () => {
    const out = qualityLintTemplate.buildWarmFollowup!(ctx);
    expect(out).toContain('safety');
    expect(out).toContain('## Verdict');
    expect(out).toContain('## Finding');
  });
});

describe('qualityLintTemplate.buildUserPrompt (cold-open path — non-regression)', () => {
  it('still includes brief / diff / planContext (unchanged)', () => {
    const out = qualityLintTemplate.buildUserPrompt(ctx);
    expect(out).toContain('BRIEF_BODY_SENTINEL_77123');
    expect(out).toContain('DIFF_BODY_SENTINEL_29348');
    expect(out).toContain('PLAN_CONTEXT_SENTINEL_55421');
  });
});
