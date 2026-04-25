import { describe, it, expect, vi } from 'vitest';
import { runSpecReview } from '@zhixuan92/multi-model-agent-core/review/spec-reviewer';
import type { Provider, ParsedStructuredReport, RunResult } from '@zhixuan92/multi-model-agent-core';

function mockProvider(outputs: string[], status: 'ok' | 'timeout' = 'ok'): Provider {
  let callCount = 0;
  return {
    name: 'complex',
    config: { type: 'claude', model: 'claude-opus-4-6' } as any,
    run: vi.fn(async (): Promise<RunResult> => ({
      output: outputs[callCount++] ?? '',
      status,
      usage: { inputTokens: 100, outputTokens: 50, totalTokens: 150, costUSD: 0.01 },
      turns: 1, filesRead: [], filesWritten: [], toolCalls: [],
      outputIsDiagnostic: false, escalationLog: [], briefQualityWarnings: [], retryable: false,
    })),
  };
}

const packet = { prompt: 'do X', scope: ['src/a.ts'], doneCondition: 'tsc passes' };
const implReport: ParsedStructuredReport = {
  summary: 'did it',
  filesChanged: [{ path: 'src/a.ts', summary: 'updated' }],
  validationsRun: [{ command: 'tsc', result: 'passed' }],
  deviationsFromBrief: [],
  unresolved: [],
};

describe('runSpecReview', () => {
  it('returns approved when reviewer approves', async () => {
    const p = mockProvider(['## Summary\napproved\n\n## Deviations from brief\n\n## Unresolved\n']);
    const r = await runSpecReview(p, packet, implReport, {}, []);
    expect(r.status).toBe('approved');
    expect(r.report).toBeDefined();
  });

  it('returns changes_required with findings when reviewer rejects', async () => {
    const p = mockProvider([
      '## Summary\nchanges_required\n\n## Deviations from brief\n- Missing null check on line 12\n\n## Unresolved\n',
    ]);
    const r = await runSpecReview(p, packet, implReport, {}, []);
    expect(r.status).toBe('changes_required');
    expect(r.findings.length).toBeGreaterThan(0);
  });

  it('preserves transport status when reviewer dispatch fails', async () => {
    const p = mockProvider(['timed out'], 'timeout');
    const r = await runSpecReview(p, packet, implReport, {}, []);
    expect(r.status).toBe('timeout');
    expect(r.errorReason).toBe('review agent returned status: timeout');
  });

  it('accepts plain text reviewer output via lenient parsing', async () => {
    const p = mockProvider(['The implementation looks fine to me, approved.']);
    const r = await runSpecReview(p, packet, implReport, {}, []);
    expect(r.status).toBe('approved');
  });

  it('returns error with reason when reviewer throws', async () => {
    const p: Provider = {
      name: 'complex',
      config: { type: 'claude', model: 'claude-opus-4-6' } as any,
      run: vi.fn(async () => { throw new Error('connection refused'); }),
    };
    const r = await runSpecReview(p, packet, implReport, {}, []);
    expect(r.status).toBe('error');
    expect(r.errorReason).toBe('review agent threw: connection refused');
  });

  it('retries once when first attempt has no parseable summary', async () => {
    const p = mockProvider([
      '',  // empty output — fails to parse even with lenient parser
      '## Summary\nApproved.\n\n## Files changed\nNone',  // retry succeeds
    ]);
    const r = await runSpecReview(p, packet, implReport, {}, []);
    expect(r.status).toBe('approved');
  });

  it('returns error after both attempts fail to parse', async () => {
    const p = mockProvider([
      '',    // empty — unparseable
      '  ',  // whitespace — still unparseable
    ]);
    const r = await runSpecReview(p, packet, implReport, {}, []);
    expect(r.status).toBe('error');
    expect(r.errorReason).toContain('missing');
  });
});
