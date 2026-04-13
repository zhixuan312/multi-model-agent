import { describe, it, expect, vi } from 'vitest';
import { runSpecReview } from '@zhixuan92/multi-model-agent-core/review/spec-reviewer';
import type { Provider, ParsedStructuredReport, RunResult } from '@zhixuan92/multi-model-agent-core';

function mockProvider(output: string, status: 'ok' | 'timeout' = 'ok'): Provider {
  return {
    name: 'complex',
    config: { type: 'claude', model: 'claude-opus-4-6' } as any,
    run: vi.fn(async (): Promise<RunResult> => ({
      output,
      status,
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
  validationsRun: [{ command: 'tsc', result: 'passed' }],
  deviationsFromBrief: [],
  unresolved: [],
};

describe('runSpecReview', () => {
  it('returns approved when reviewer approves', async () => {
    const p = mockProvider('## Summary\napproved\n\n## Deviations from brief\n\n## Unresolved\n');
    const r = await runSpecReview(p, packet, implReport, {}, []);
    expect(r.status).toBe('approved');
    expect(r.report).toBeDefined();
  });

  it('returns changes_required with findings when reviewer rejects', async () => {
    const p = mockProvider(
      '## Summary\nchanges_required\n\n## Deviations from brief\n- Missing null check on line 12\n\n## Unresolved\n',
    );
    const r = await runSpecReview(p, packet, implReport, {}, []);
    expect(r.status).toBe('changes_required');
    expect(r.findings.length).toBeGreaterThan(0);
  });

  it('returns error on reviewer dispatch failure', async () => {
    const p = mockProvider('timed out', 'timeout');
    const r = await runSpecReview(p, packet, implReport, {}, []);
    expect(r.status).toBe('error');
  });
});
