import { describe, it, expect, vi } from 'vitest';
import type { Provider, RunResult } from '../../packages/core/src/types.js';
import type { RunOptions } from '../../packages/core/src/runners/types.js';
import { runQualityReview } from '../../packages/core/src/review/quality-reviewer.js';
import type { ParsedStructuredReport } from '../../packages/core/src/reporting/structured-report.js';
import type { WorkerFinding } from '../../packages/core/src/executors/_shared/findings-schema.js';

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

// ---------------------------------------------------------------------------
// Gating-path tests (filesWritten non-empty, no qualityReviewPromptBuilder)
// ---------------------------------------------------------------------------

describe('runQualityReview gating path — taskDeadlineMs / abortSignal plumbing', () => {
  it('aborts when abortSignal fires before the call', async () => {
    const ctrl = new AbortController();
    ctrl.abort();
    const provider = makeProvider(async (signal) => {
      if (signal?.aborted) return makeAbortedResult();
      return makeOkResult('## Summary\napproved');
    });
    const result = await runQualityReview(
      provider,
      { prompt: 'p', scope: [], doneCondition: 'd' },
      fakeReport,
      {},
      [],
      ['file.ts'],
      undefined,
      undefined,
      undefined,
      /*deadline*/ Date.now() + 60_000,
      ctrl.signal,
    );
    expect(result.status).toBe('api_aborted');
  });

  it('clamps per-call timeoutMs when taskDeadlineMs has passed', async () => {
    let captured: number | undefined;
    const provider = makeProvider(async (_signal, timeoutMs) => {
      captured = timeoutMs;
      return makeOkResult('## Summary\napproved');
    });
    await runQualityReview(
      provider,
      { prompt: 'p', scope: [], doneCondition: 'd' },
      fakeReport,
      {},
      [],
      ['file.ts'],
      undefined,
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
    await runQualityReview(
      provider,
      { prompt: 'p', scope: [], doneCondition: 'd' },
      fakeReport,
      {},
      [],
      ['file.ts'],
      undefined,
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
        // which triggers the retry path in runQualityReview.
        if (signal?.aborted) return makeAbortedResult();
        return makeOkResult('');
      }
      // After first call, fire abort; retry should see it.
      ctrl.abort();
      return makeAbortedResult();
    });
    const result = await runQualityReview(
      provider,
      { prompt: 'p', scope: [], doneCondition: 'd' },
      fakeReport,
      {},
      [],
      ['file.ts'],
      undefined,
      undefined,
      undefined,
      undefined,
      ctrl.signal,
    );
    expect(['error', 'api_error', 'network_error', 'timeout', 'api_aborted']).toContain(result.status);
    expect(calls).toBeGreaterThanOrEqual(1);
  });
});

// ---------------------------------------------------------------------------
// Annotation-path tests (qualityReviewPromptBuilder + workerOutput provided)
// ---------------------------------------------------------------------------

function makeAnnotationPromptBuilder(): (ctx: {
  workerOutput: string;
  brief: string;
  workerFindings: WorkerFinding[];
}) => string {
  return (ctx) => `Review these findings:\n${JSON.stringify(ctx.workerFindings)}`;
}

function makeWorkerOutputWithFindings(): string {
  return '```json\n[{"id":"1","severity":"high","claim":"null pointer deref","evidence":"On line 42 of a.ts, the variable x is dereferenced without a null check, which would cause a runtime crash when the input is empty.","suggestion":"Add null guard before deref"}]\n```';
}

describe('runQualityReview annotation path — taskDeadlineMs / abortSignal plumbing', () => {
  it('aborts when abortSignal fires before the call', async () => {
    const ctrl = new AbortController();
    ctrl.abort();
    const provider = makeProvider(async (signal) => {
      if (signal?.aborted) return makeAbortedResult();
      return makeOkResult('```json\n[{"id":"1","reviewerConfidence":80}]\n```');
    });
    const result = await runQualityReview(
      provider,
      { prompt: 'p', scope: [], doneCondition: 'd' },
      fakeReport,
      {},
      [],
      [], // empty filesWritten — but annotation path bypasses that check
      undefined,
      makeAnnotationPromptBuilder(),
      makeWorkerOutputWithFindings(),
      /*deadline*/ Date.now() + 60_000,
      ctrl.signal,
    );
    expect(result.status).toBe('api_aborted');
  });

  it('clamps per-call timeoutMs when taskDeadlineMs has passed', async () => {
    let captured: number | undefined;
    const provider = makeProvider(async (_signal, timeoutMs) => {
      captured = timeoutMs;
      return makeOkResult('```json\n[{"id":"1","reviewerConfidence":80}]\n```');
    });
    await runQualityReview(
      provider,
      { prompt: 'p', scope: [], doneCondition: 'd' },
      fakeReport,
      {},
      [],
      [],
      undefined,
      makeAnnotationPromptBuilder(),
      makeWorkerOutputWithFindings(),
      /*deadline=in the past*/ Date.now() - 1000,
    );
    expect(captured).toBeLessThanOrEqual(2);
  });

  it('forwards onProgress callback through delegateWithEscalation to provider.run', async () => {
    let capturedOnProgress: ((e: any) => void) | undefined;
    const provider: Provider = {
      name: 'standard',
      config: { type: 'openai-compatible', model: 'mock', baseUrl: 'mock' } as any,
      run: async (_prompt: string, opts?: RunOptions) => {
        capturedOnProgress = opts?.onProgress;
        return makeOkResult('```json\n[{"id":"1","reviewerConfidence":80}]\n```');
      },
    };
    const sink = vi.fn();
    await runQualityReview(
      provider,
      { prompt: 'p', scope: [], doneCondition: 'd' },
      fakeReport,
      {},
      [],
      [],
      undefined,
      makeAnnotationPromptBuilder(),
      makeWorkerOutputWithFindings(),
      undefined,
      undefined,
      sink,
    );
    expect(capturedOnProgress).toBeDefined();
  });

  it('surfaces api_aborted from delegateWithEscalation in annotation path', async () => {
    // When delegateWithEscalation returns api_aborted (because the signal was
    // already aborted before provider.run), the annotation path must preserve
    // it rather than collapsing to generic 'error'.
    const ctrl = new AbortController();
    ctrl.abort();
    let capturedSignal: AbortSignal | undefined;
    const provider: Provider = {
      name: 'standard',
      config: { type: 'openai-compatible', model: 'mock', baseUrl: 'mock' } as any,
      run: async (_prompt: string, opts?: RunOptions) => {
        capturedSignal = opts?.abortSignal;
        if (opts?.abortSignal?.aborted) return makeAbortedResult();
        return makeOkResult('```json\n[{"id":"1","reviewerConfidence":80}]\n```');
      },
    };
    const result = await runQualityReview(
      provider,
      { prompt: 'p', scope: [], doneCondition: 'd' },
      fakeReport,
      {},
      [],
      [],
      undefined,
      makeAnnotationPromptBuilder(),
      makeWorkerOutputWithFindings(),
      /*deadline*/ Date.now() + 60_000,
      ctrl.signal,
    );
    expect(capturedSignal).toBeDefined();
    expect(result.status).toBe('api_aborted');
  });
});
