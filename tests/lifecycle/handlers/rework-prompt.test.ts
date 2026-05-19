import { describe, it, expect } from 'vitest';
import { reworkPrompt } from '../../../packages/core/src/lifecycle/handlers/rework-prompt.js';

const ctx = {
  workerOutput: 'IMPLEMENTER_OUTPUT_SENTINEL_43891',
  brief: 'BRIEF_BODY_SENTINEL_77123',
  diff: 'DIFF_BODY_SENTINEL_29348',
  planContext: 'PLAN_CONTEXT_SENTINEL_55421',
  priorConcerns: ['[spec] concern_one_sentinel_88', '[quality] concern_two_sentinel_99'],
};

describe('reworkPrompt — warm-followup body', () => {
  it('does NOT include the brief body', () => {
    expect(reworkPrompt(ctx)).not.toContain('BRIEF_BODY_SENTINEL_77123');
  });

  it('does NOT include the worker output body', () => {
    expect(reworkPrompt(ctx)).not.toContain('IMPLEMENTER_OUTPUT_SENTINEL_43891');
  });

  it('does NOT include the diff body', () => {
    expect(reworkPrompt(ctx)).not.toContain('DIFF_BODY_SENTINEL_29348');
  });

  it('does NOT include the planContext body', () => {
    expect(reworkPrompt(ctx)).not.toContain('PLAN_CONTEXT_SENTINEL_55421');
  });

  it('DOES include each prior concern verbatim', () => {
    const out = reworkPrompt(ctx);
    expect(out).toContain('concern_one_sentinel_88');
    expect(out).toContain('concern_two_sentinel_99');
  });

  it('DOES include a clear "fix these" action instruction', () => {
    const out = reworkPrompt(ctx);
    expect(out.toLowerCase()).toContain('fix');
  });
});

describe('reworkPrompt — workerStatus calibration (anti-pessimism guard)', () => {
  it('buildUserPrompt Action step 4 ties Could-not-fix=empty → workerStatus="done"', () => {
    const out = reworkPrompt(ctx);
    expect(out).toMatch(/workerStatus to "done" if your "Could not fix" line is empty/);
    expect(out).toMatch(/Reserve "failed" \/ "blocked" for deviations you could not address/);
  });
});

describe('reworkPrompt — edge cases', () => {
  it('handles the (none) priorConcerns case without including banned fields', () => {
    const out = reworkPrompt({
      ...ctx,
      priorConcerns: [],
    });
    expect(out).not.toContain('BRIEF_BODY_SENTINEL_77123');
    expect(out).not.toContain('DIFF_BODY_SENTINEL_29348');
  });
});
