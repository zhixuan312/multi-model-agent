import { describe, it, expect, vi } from 'vitest';
import type { MultiModelConfig } from '@zhixuan92/multi-model-agent-core';

// Verify that stage transitions fire correctly through the transitionStage
// helper. We can't spy on transitionStage directly (it's a closure inside
// executeReviewedLifecycle), so we observe externally-visible effects:
//   - stageStats idle fields (null for un-entered, populated for entered)
//   - correct stage progression in the result

vi.mock('@zhixuan92/multi-model-agent-core/provider', () => {
  const impl = {
    output: '## Summary\ndone\n\n## Files changed\n- src/a.ts: updated\n\n## Normalization decisions\n\n## Validations run\n- tsc: passed\n\n## Deviations from brief\n\n## Unresolved\n',
    status: 'ok' as const,
    usage: { inputTokens: 100, outputTokens: 50, totalTokens: 150, costUSD: 0.01 },
    turns: 3, filesRead: ['src/a.ts'], filesWritten: ['src/a.ts'],
    toolCalls: ['readFile(src/a.ts)', 'writeFile(src/a.ts)'],
    outputIsDiagnostic: false, escalationLog: [], briefQualityWarnings: [], retryable: false,
  };

  const review = {
    output: '## Summary\napproved\n\n## Deviations from brief\n\n## Unresolved\n',
    status: 'ok' as const,
    usage: { inputTokens: 50, outputTokens: 25, totalTokens: 75, costUSD: 0.005 },
    turns: 1, filesRead: [], filesWritten: [], toolCalls: [],
    outputIsDiagnostic: false, escalationLog: [], briefQualityWarnings: [], retryable: false,
  };

  return {
    createProvider: (_slot: string) => ({
      name: _slot,
      config: { type: 'openai-compatible' as const, model: `${_slot}-model`, baseUrl: 'https://ex.invalid/v1' },
      run: async (prompt: string) => {
        if (typeof prompt === 'string' && prompt.startsWith('You are a spec compliance reviewer')) return review;
        if (typeof prompt === 'string' && prompt.startsWith('You are a code quality reviewer')) return review;
        return impl;
      },
    }),
  };
});

vi.mock('fs/promises', () => ({
  readFile: vi.fn().mockResolvedValue('// mock file content\nconst x = 1;\n'),
}));

import { runTasks } from '@zhixuan92/multi-model-agent-core/run-tasks';

const config: MultiModelConfig = {
  agents: {
    standard: { type: 'openai-compatible', model: 'std', baseUrl: 'https://ex.invalid/v1' },
    complex: { type: 'openai-compatible', model: 'cpx', baseUrl: 'https://ex2.invalid/v1' },
  },
  defaults: { timeoutMs: 600_000, tools: 'full' },
};

describe('stage transitions via transitionStage helper', () => {
  it('happy-path lifecycle populates idle fields for entered stages', async () => {
    // Without autoCommit, the lifecycle skips commit/verify/diff_review.
    // Stages entered: implementing → spec_review → quality_review → terminal.
    // That's 4 transitionStage calls (3 stage transitions + terminal).
    const results = await runTasks(
      [{ prompt: 'do the task at src/a.ts. Done when tsc passes.', agentType: 'standard' as const }],
      config,
    );
    const r = results[0];
    expect(r.status).toBe('ok');
    expect(r.stageStats).toBeDefined();
    const s = r.stageStats!;
    // Entered stages have populated idle fields (snapshotIdle was passed).
    expect(s.implementing.entered).toBe(true);
    expect(s.implementing.maxIdleMs).not.toBeNull();
    expect(s.implementing.totalIdleMs).not.toBeNull();
    expect(s.implementing.activityEvents).not.toBeNull();
    expect(s.spec_review.entered).toBe(true);
    expect(s.spec_review.maxIdleMs).not.toBeNull();
    expect(s.quality_review.entered).toBe(true);
    expect(s.quality_review.maxIdleMs).not.toBeNull();
    // Non-entered stages keep null idle fields.
    expect(s.spec_rework.entered).toBe(false);
    expect(s.spec_rework.maxIdleMs).toBeNull();
    expect(s.quality_rework.entered).toBe(false);
    expect(s.quality_rework.maxIdleMs).toBeNull();
  });

  it('reviewPolicy=off fires terminal transition early from verifying', async () => {
    // Stages entered: implementing → terminal.
    // Spec/quality review stages are skipped entirely.
    const results = await runTasks(
      [{
        prompt: 'do the task at src/a.ts. Done when tsc passes.',
        agentType: 'standard' as const,
        reviewPolicy: 'off',
      }],
      config,
    );
    expect(results[0].specReviewStatus).toBe('skipped');
    // Implementing was entered and has idle data; review stages were skipped.
    expect(results[0].stageStats?.implementing.entered).toBe(true);
    expect(results[0].stageStats?.implementing.maxIdleMs).not.toBeNull();
    expect(results[0].stageStats?.spec_review.entered).toBe(false);
    expect(results[0].stageStats?.spec_review.maxIdleMs).toBeNull();
  });

  it('stage idle tracker resets on each transition — independent snapshots per stage', async () => {
    const results = await runTasks(
      [{ prompt: 'do the task at src/a.ts. Done when tsc passes.', agentType: 'standard' as const }],
      config,
    );
    // Each entered stage gets its own idle snapshot because transitionStage
    // resets stageIdle to a fresh tracker on every call.
    const s = results[0].stageStats!;
    expect(s.implementing.maxIdleMs).toBeGreaterThanOrEqual(0);
    expect(s.spec_review.entered).toBe(true);
    expect(s.spec_review.maxIdleMs).toBeGreaterThanOrEqual(0);
    // Both are independently recorded — not the same tracker instance.
  });
});
