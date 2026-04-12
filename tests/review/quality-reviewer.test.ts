import { describe, it, expect, vi } from 'vitest';
import { runQualityReview } from '@zhixuan92/multi-model-agent-core/review/quality-reviewer';
import type { Provider, ParsedStructuredReport, RunResult } from '@zhixuan92/multi-model-agent-core';

function mockProvider(output: string): Provider {
  return {
    name: 'complex',
    config: { type: 'claude', model: 'claude-opus-4-6' } as any,
    run: vi.fn(async (): Promise<RunResult> => ({
      output, status: 'ok',
      usage: { inputTokens: 100, outputTokens: 50, totalTokens: 150, costUSD: 0.01 },
      turns: 1, filesRead: [], filesWritten: [], toolCalls: [],
      outputIsDiagnostic: false, escalationLog: [], briefQualityWarnings: [], retryable: false,
    })),
  };
}

const packet = { normalizedPrompt: 'do X', scope: ['src/a.ts'], doneCondition: 'tsc passes' };
const implReport: ParsedStructuredReport = {
  summary: 'did it',
  filesChanged: [{ path: 'src/a.ts', summary: 'updated' }],
  normalizationDecisions: [],
  validationsRun: [],
  deviationsFromBrief: [],
  unresolved: [],
};

describe('runQualityReview', () => {
  it('returns approved on clean review', async () => {
    const p = mockProvider('## Summary\napproved\n');
    const r = await runQualityReview(p, packet, implReport, {}, [], ['src/a.ts']);
    expect(r.status).toBe('approved');
  });

  it('returns changes_required with findings on issues', async () => {
    const p = mockProvider('## Summary\nchanges_required\n\n## Deviations from brief\n- No error handling on JWT verify\n');
    const r = await runQualityReview(p, packet, implReport, {}, [], ['src/a.ts']);
    expect(r.status).toBe('changes_required');
    expect(r.findings.length).toBeGreaterThan(0);
  });

  it('auto-skips when filesWritten is empty', async () => {
    const p = mockProvider('should not be called');
    const r = await runQualityReview(p, packet, implReport, {}, [], []);
    expect(r.status).toBe('not_run');
    expect((p.run as any).mock.calls.length).toBe(0);
  });
});