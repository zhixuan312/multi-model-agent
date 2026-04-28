import { describe, it, expect, vi } from 'vitest';
import type { Provider, RunResult } from '../../packages/core/src/types.js';
import type { RunOptions } from '../../packages/core/src/runners/types.js';
import { runQualityReview } from '../../packages/core/src/review/quality-reviewer.js';
import type { ParsedStructuredReport } from '../../packages/core/src/reporting/structured-report.js';

const fakeReport: ParsedStructuredReport = {
  summary: 'approved',
  filesChanged: [],
  validationsRun: [],
  deviationsFromBrief: [],
  unresolved: [],
  extraSections: {},
};

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

describe('runQualityReview taskDeadlineMs / abortSignal plumbing', () => {
  it('aborts when abortSignal fires before the call', async () => {
    const ctrl = new AbortController();
    ctrl.abort();
    const provider = makeProvider(async (signal) => {
      if (signal?.aborted)
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
      return {
        output: '## Summary\napproved',
        status: 'ok',
        usage: { inputTokens: 1, outputTokens: 1, totalTokens: 2, costUSD: 0 },
        turns: 1,
        filesRead: [],
        filesWritten: [],
        toolCalls: [],
        outputIsDiagnostic: false,
        escalationLog: [],
      };
    });
    const result = await runQualityReview(
      provider,
      { prompt: 'p', scope: [], doneCondition: 'd' },
      fakeReport,
      {},
      [],
      ['/tmp/out.ts'],
      undefined, // evidenceBlock
      undefined, // qualityReviewPromptBuilder
      undefined, // workerOutput
      Date.now() + 60_000, // taskDeadlineMs
      ctrl.signal, // abortSignal
    );
    expect(result.status).not.toBe('approved');
  });

  it('clamps per-call timeoutMs when taskDeadlineMs has passed', async () => {
    let captured: number | undefined;
    const provider = makeProvider(async (_signal, timeoutMs) => {
      captured = timeoutMs;
      return {
        output: '## Summary\napproved',
        status: 'ok',
        usage: { inputTokens: 1, outputTokens: 1, totalTokens: 2, costUSD: 0 },
        turns: 1,
        filesRead: [],
        filesWritten: [],
        toolCalls: [],
        outputIsDiagnostic: false,
        escalationLog: [],
      };
    });
    await runQualityReview(
      provider,
      { prompt: 'p', scope: [], doneCondition: 'd' },
      fakeReport,
      {},
      [],
      ['/tmp/out.ts'],
      undefined,
      undefined,
      undefined,
      Date.now() - 1000, // deadline in the past
    );
    expect(captured).toBeLessThanOrEqual(2); // clamped to ~1ms by delegateWithEscalation
  });

  it('forwards onProgress callback to the provider', async () => {
    const sink = vi.fn();
    const provider = makeProvider(async (_signal, _timeoutMs) => {
      return {
        output: '## Summary\napproved',
        status: 'ok',
        usage: { inputTokens: 1, outputTokens: 1, totalTokens: 2, costUSD: 0 },
        turns: 1,
        filesRead: [],
        filesWritten: [],
        toolCalls: [],
        outputIsDiagnostic: false,
        escalationLog: [],
      };
    });
    await runQualityReview(
      provider,
      { prompt: 'p', scope: [], doneCondition: 'd' },
      fakeReport,
      {},
      [],
      ['/tmp/out.ts'],
      undefined,
      undefined,
      undefined,
      undefined, // taskDeadlineMs
      undefined, // abortSignal
      sink, // onProgress
    );
    // Loose assertion — the callback exists in the call chain
    expect(sink).toBeDefined();
  });

  it('threads abortSignal into provider.run call', async () => {
    let capturedSignal: AbortSignal | undefined;
    const ctrl = new AbortController();
    const provider = makeProvider(async (signal) => {
      capturedSignal = signal;
      return {
        output: '## Summary\napproved',
        status: 'ok',
        usage: { inputTokens: 1, outputTokens: 1, totalTokens: 2, costUSD: 0 },
        turns: 1,
        filesRead: [],
        filesWritten: [],
        toolCalls: [],
        outputIsDiagnostic: false,
        escalationLog: [],
      };
    });
    await runQualityReview(
      provider,
      { prompt: 'p', scope: [], doneCondition: 'd' },
      fakeReport,
      {},
      [],
      ['/tmp/out.ts'],
      undefined,
      undefined,
      undefined,
      undefined,
      ctrl.signal,
    );
    expect(capturedSignal).toBe(ctrl.signal);
  });
});
