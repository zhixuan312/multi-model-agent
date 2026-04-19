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

describe('DEBUG: mock call tracking', () => {
  it('mock should return different outputs on successive calls', async () => {
    const p = mockProvider(['first', 'second']);
    const r1 = await p.run('prompt', {} as any);
    console.log('Call 1 output:', r1.output, 'callCount should be 1');
    const r2 = await p.run('prompt', {} as any);
    console.log('Call 2 output:', r2.output, 'callCount should be 2');
    expect(r1.output).toBe('first');
    expect(r2.output).toBe('second');
  });
});

describe('DEBUG: runSpecReview retry', () => {
  it('debug retry behavior', async () => {
    const p = mockProvider([
      '',  // empty output — fails to parse
      '## Summary\nApproved.\n\n## Files changed\nNone',  // retry succeeds
    ]);
    
    // Patch parseStructuredReport to debug
    const r = await runSpecReview(p, packet, implReport, {}, []);
    console.log('Result status:', r.status);
    console.log('Error reason:', r.errorReason);
    expect(r.status).toBe('approved');
  });
});
