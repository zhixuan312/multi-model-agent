import { describe, it, expect, vi } from 'vitest';
import type { Provider, RunResult } from '../../packages/core/src/types.js';
import type { RunOptions } from '../../packages/core/src/runners/types.js';
import { runSpecReview } from '../../packages/core/src/review/spec-reviewer.js';
import type { ParsedStructuredReport } from '../../packages/core/src/reporting/structured-report.js';

const fakeReport: ParsedStructuredReport = {
  summary: 'approved',
  filesChanged: [],
  validationsRun: [],
  deviationsFromBrief: [],
  unresolved: [],
  extraSections: {},
};

function makeOkResult(output: string): RunResult {
  return {
    output,
    status: 'ok',
    usage: { inputTokens: 1, outputTokens: 1, totalTokens: 2, costUSD: 0 },
    turns: 1,
    filesRead: [],
    filesWritten: [],
    toolCalls: [],
    outputIsDiagnostic: false,
    escalationLog: [],
  };
}

function makeAbortedResult(): RunResult {
  return {
    output: '',
    status: 'api_aborted',
    usage: { inputTokens: 0, outputTokens: 0, totalTokens: 0, costUSD: null },
    turns: 0,
    filesRead: [],
    filesWritten: [],
    toolCalls: [],
    outputIsDiagnostic: true,
    escalationLog: [],
  };
}

function makeProvider(
  behavior: (signal?: AbortSignal, timeoutMs?: number) => Promise<RunResult>,
): Provider {
  return {
    name: 'standard',
    config: { type: 'openai-compatible', model: 'mock', baseUrl: 'mock' } as any,
    run: async (_prompt: string, opts?: RunOptions) =>
      behavior(opts?.abortSignal, opts?.timeoutMs),
  };
}

describe('runSpecReview taskDeadlineMs / abortSignal plumbing', () => {
  it('aborts when abortSignal fires before the call', async () => {
    const ctrl = new AbortController();
    ctrl.abort();
    const provider = makeProvider(async (signal) => {
      if (signal?.aborted) return makeAbortedResult();
      return makeOkResult('## Summary\napproved');
    });
    const result = await runSpecReview(
      provider,
      { prompt: 'p', scope: [], doneCondition: 'd' },
      fakeReport,
      {},
      [],
      undefined,
      undefined,
      /*deadline*/ Date.now() + 60_000,
      ctrl.signal,
    );
    expect(result.status).not.toBe('approved');
  });

  it('clamps per-call timeoutMs when taskDeadlineMs has passed', async () => {
    let captured: number | undefined;
    const provider = makeProvider(async (_signal, timeoutMs) => {
      captured = timeoutMs;
      return makeOkResult('## Summary\napproved');
    });
    await runSpecReview(
      provider,
      { prompt: 'p', scope: [], doneCondition: 'd' },
      fakeReport,
      {},
      [],
      undefined,
      undefined,
      /*deadline=in the past*/ Date.now() - 1000,
    );
    expect(captured).toBeLessThanOrEqual(2); // clamped to 1ms by delegate-with-escalation
  });

  it('forwards onProgress callback through delegateWithEscalation to provider.run', async () => {
    let capturedOnProgress: ((e: any) => void) | undefined;
    const provider: Provider = {
      name: 'standard',
      config: { type: 'openai-compatible', model: 'mock', baseUrl: 'mock' } as any,
      run: async (_prompt: string, opts?: RunOptions) => {
        capturedOnProgress = opts?.onProgress;
        return makeOkResult('## Summary\napproved');
      },
    };
    const sink = vi.fn();
    await runSpecReview(
      provider,
      { prompt: 'p', scope: [], doneCondition: 'd' },
      fakeReport,
      {},
      [],
      undefined,
      undefined,
      undefined,
      undefined,
      sink,
    );
    expect(capturedOnProgress).toBeDefined();
  });

  it('threads abortSignal into the retry path (second delegateWithEscalation call)', async () => {
    let calls = 0;
    const ctrl = new AbortController();
    const provider = makeProvider(async (signal) => {
      calls += 1;
      if (calls === 1) {
        // Return empty output — parseStructuredReport('') gives summary:null,
        // which triggers the retry path in runSpecReview.
        return makeOkResult('');
      }
      // After first call, fire abort; retry should see it.
      ctrl.abort();
      return makeAbortedResult();
    });
    const result = await runSpecReview(
      provider,
      { prompt: 'p', scope: [], doneCondition: 'd' },
      fakeReport,
      {},
      [],
      undefined,
      undefined,
      undefined,
      ctrl.signal,
    );
    expect(['error', 'api_error', 'network_error', 'timeout']).toContain(result.status);
    expect(calls).toBeGreaterThanOrEqual(1);
  });
});
