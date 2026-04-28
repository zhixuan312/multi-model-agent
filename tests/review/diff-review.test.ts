import { describe, it, expect } from 'vitest';
import { runDiffReview } from '../../packages/core/src/review/diff-review.js';

describe('runDiffReview taskDeadlineMs / abortSignal plumbing', () => {
  it('returns transport_failure when abortSignal aborts before worker.call', async () => {
    const ctrl = new AbortController();
    ctrl.abort();
    const result = await runDiffReview({
      cwd: '/tmp',
      diff: '+ x\n',
      diffTruncated: false,
      verification: { status: 'skipped', steps: [], totalDurationMs: 0, skipReason: 'no_command' } as any,
      worker: {
        call: async (_prompt: string, opts?: { abortSignal?: AbortSignal; timeoutMs?: number }) => {
          if (opts?.abortSignal?.aborted) return { output: '', status: 'api_aborted' };
          return { output: 'APPROVE' };
        },
      },
      taskDeadlineMs: Date.now() + 60_000,
      abortSignal: ctrl.signal,
    });
    expect(['transport_failure']).toContain(result.kind);
  });

  it('clamps worker timeoutMs to ~1ms when taskDeadlineMs has passed', async () => {
    let captured: number | undefined;
    const result = await runDiffReview({
      cwd: '/tmp',
      diff: '+ x\n',
      diffTruncated: false,
      verification: { status: 'skipped', steps: [], totalDurationMs: 0, skipReason: 'no_command' } as any,
      worker: {
        call: async (_prompt, opts) => {
          captured = opts?.timeoutMs;
          return { output: 'APPROVE' };
        },
      },
      taskDeadlineMs: Date.now() - 1000,
    });
    expect(captured).toBeLessThanOrEqual(2);
    expect(result.kind).toBe('approve');
  });
});
