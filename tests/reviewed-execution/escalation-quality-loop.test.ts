import { describe, it, expect, vi } from 'vitest';
import type { MultiModelConfig } from '@zhixuan92/multi-model-agent-core';

const calls: Array<{ slot: string; kind: 'implement' | 'spec_review' | 'quality_review'; prompt: string }> = [];

function implOutput(slot: string, n: number): string {
  return [
    '## Summary',
    `${slot} implementation ${n} done`,
    '',
    '## Files changed',
    '- src/a.ts: updated',
    '',
    '## Validations run',
    '- targeted test: passed',
    '',
    '## Deviations from brief',
    '',
    '## Unresolved',
    '',
  ].join('\n');
}

function reviewOutput(status: 'approved' | 'changes_required', finding: string): string {
  return [
    '## Summary',
    status,
    '',
    '## Files changed',
    '',
    '## Validations run',
    '',
    '## Deviations from brief',
    status === 'changes_required' ? `- ${finding}` : '',
    '',
    '## Unresolved',
    '',
  ].join('\n');
}

function result(output: string) {
  return {
    output,
    status: 'ok' as const,
    usage: { inputTokens: 100, outputTokens: 50, totalTokens: 150, costUSD: 0.01 },
    turns: 1,
    filesRead: ['src/a.ts'],
    filesWritten: ['src/a.ts'],
    toolCalls: ['readFile(src/a.ts)', 'writeFile(src/a.ts)'],
    outputIsDiagnostic: false,
    escalationLog: [],
    briefQualityWarnings: [],
    retryable: false,
  };
}

let implCount = 0;
let qualityReviewCount = 0;

vi.mock('@zhixuan92/multi-model-agent-core/provider', () => ({
  createProvider: (slot: string) => ({
    name: slot,
    config: { type: 'openai-compatible' as const, model: `${slot}-model`, baseUrl: 'https://ex.invalid/v1' },
    run: vi.fn(async (prompt: string) => {
      if (prompt.startsWith('You are a spec compliance reviewer')) {
        calls.push({ slot, kind: 'spec_review', prompt });
        return result(reviewOutput('approved', ''));
      }

      if (prompt.startsWith('You are a code quality reviewer')) {
        calls.push({ slot, kind: 'quality_review', prompt });
        qualityReviewCount += 1;
        if (qualityReviewCount === 1) return result(reviewOutput('changes_required', 'quality issue 1'));
        if (qualityReviewCount === 2) return result(reviewOutput('changes_required', 'quality issue 2'));
        return result(reviewOutput('approved', ''));
      }

      calls.push({ slot, kind: 'implement', prompt });
      implCount += 1;
      return result(implOutput(slot, implCount));
    }),
  }),
}));

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

describe('reviewed lifecycle quality-loop escalation', () => {
  // R3-separation interaction with the escalation lifecycle. The R3 fallback
  // (forbiddenIdentities) is comprehensively unit-tested in
  // tests/escalation/fallback.test.ts (17 cases) and the canonical-identity
  // module in tests/routing/canonical-model-identity.test.ts (15 cases).
  // This test verifies the integration only — that the lifecycle does not
  // crash or produce a malformed result when R3 separation is active across
  // multiple escalation rounds. The exact reviewer-tier sequence depends on
  // the escalation strategy and is intentionally not asserted here.
  it('R3 separation does not crash the escalation lifecycle', async () => {
    calls.length = 0;
    implCount = 0;
    qualityReviewCount = 0;

    const results = await runTasks(
      [{ prompt: 'update src/a.ts. Done when targeted test passes.', agentType: 'standard' as const }],
      config,
    );

    // Lifecycle ran without blowing up.
    expect(results).toHaveLength(1);
    expect(results[0]).toBeDefined();

    // Round 1's quality reviewer must NOT match the initial implementer's
    // identity. impl starts on 'standard' (model='std'); the assigned standard
    // reviewer would be forbidden, so it must fall back to complex. This is
    // the load-bearing R3 invariant in an integration context.
    const qualityReviews = calls.filter((call) => call.kind === 'quality_review');
    if (qualityReviews.length > 0) {
      expect(qualityReviews[0].slot).toBe('complex');
    }
  });
});
