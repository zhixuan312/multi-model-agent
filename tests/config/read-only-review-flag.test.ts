import { describe, expect, it } from 'vitest';
import { resolveReadOnlyReviewFlag } from '../../packages/core/src/config/read-only-review-flag.js';

describe('resolveReadOnlyReviewFlag', () => {
  it('returns enabled for all 5 routes when env var is unset', () => {
    delete process.env['MMAGENT_READ_ONLY_REVIEW'];
    const f = resolveReadOnlyReviewFlag();
    expect(f.isEnabledFor('audit_document')).toBe(true);
    expect(f.isEnabledFor('review_code')).toBe(true);
    expect(f.isEnabledFor('verify_work')).toBe(true);
    expect(f.isEnabledFor('investigate_codebase')).toBe(true);
    expect(f.isEnabledFor('debug_task')).toBe(true);
  });

  it('returns disabled for all when env var is "disabled"', () => {
    process.env['MMAGENT_READ_ONLY_REVIEW'] = 'disabled';
    const f = resolveReadOnlyReviewFlag();
    expect(f.isEnabledFor('audit_document')).toBe(false);
    expect(f.isEnabledFor('debug_task')).toBe(false);
  });

  it('returns enabled only for listed routes when env var is a CSV', () => {
    process.env['MMAGENT_READ_ONLY_REVIEW'] = 'audit_document,investigate_codebase';
    const f = resolveReadOnlyReviewFlag();
    expect(f.isEnabledFor('audit_document')).toBe(true);
    expect(f.isEnabledFor('investigate_codebase')).toBe(true);
    expect(f.isEnabledFor('review_code')).toBe(false);
    expect(f.isEnabledFor('debug_task')).toBe(false);
  });
});
