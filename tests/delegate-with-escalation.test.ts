import { describe, it, expect, vi } from 'vitest';
import { delegateWithEscalation } from '../packages/core/src/delegate-with-escalation.js';
import type {
  TaskSpec,
  RunResult,
  Provider,
  ProgressEvent,
} from '../packages/core/src/types.js';

function makeMockResult(
  status: RunResult['status'],
  output = '',
  outputIsDiagnostic = false,
): RunResult {
  return {
    output,
    status,
    usage: { inputTokens: 100, outputTokens: 50, totalTokens: 150, costUSD: 0 },
    turns: 5,
    filesRead: [],
    filesWritten: [],
    toolCalls: [],
    outputIsDiagnostic,
    escalationLog: [],
  };
}

describe('delegateWithEscalation', () => {
  it('returns immediately on first ok', async () => {
    const okProvider: Provider = {
      name: 'cheap',
      config: { type: 'codex', model: 'gpt-5-codex' },
      run: vi.fn().mockResolvedValue(makeMockResult('ok', 'success')),
    };
    const expensiveProvider: Provider = {
      name: 'expensive',
      config: { type: 'codex', model: 'gpt-5-codex' },
      run: vi.fn().mockResolvedValue(makeMockResult('ok', 'should not be called')),
    };

    const task: TaskSpec = { prompt: 'test', tier: 'standard', requiredCapabilities: [] };
    const result = await delegateWithEscalation(task, [okProvider, expensiveProvider]);

    expect(result.status).toBe('ok');
    expect(result.output).toBe('success');
    expect(result.escalationLog).toHaveLength(1);
    expect(result.escalationLog[0].provider).toBe('cheap');
    expect(result.escalationLog[0].status).toBe('ok');
    expect(result.escalationLog[0].reason).toBeUndefined();
    expect(expensiveProvider.run).not.toHaveBeenCalled();
  });

  it('escalates on incomplete', async () => {
    const failingProvider: Provider = {
      name: 'cheap',
      config: { type: 'codex', model: 'gpt-5-codex' },
      run: vi.fn().mockResolvedValue(makeMockResult('incomplete', 'partial work')),
    };
    const okProvider: Provider = {
      name: 'expensive',
      config: { type: 'codex', model: 'gpt-5-codex' },
      run: vi.fn().mockResolvedValue(makeMockResult('ok', 'complete answer')),
    };

    const task: TaskSpec = { prompt: 'test', tier: 'standard', requiredCapabilities: [] };
    const result = await delegateWithEscalation(task, [failingProvider, okProvider]);

    expect(result.status).toBe('ok');
    expect(result.output).toBe('complete answer');
    expect(result.escalationLog).toHaveLength(2);
    expect(result.escalationLog[0].provider).toBe('cheap');
    expect(result.escalationLog[0].status).toBe('incomplete');
    expect(result.escalationLog[0].reason).toBe('status=incomplete');
    expect(result.escalationLog[1].provider).toBe('expensive');
    expect(result.escalationLog[1].status).toBe('ok');
  });

  it('returns the best salvageable output when all providers fail', async () => {
    const cheapFail: Provider = {
      name: 'cheap',
      config: { type: 'codex', model: 'gpt-5-codex' },
      run: vi.fn().mockResolvedValue(makeMockResult('incomplete', 'short partial')),
    };
    const expensiveFail: Provider = {
      name: 'expensive',
      config: { type: 'codex', model: 'gpt-5-codex' },
      run: vi
        .fn()
        .mockResolvedValue(
          makeMockResult('incomplete', 'a much longer partial result with more useful content'),
        ),
    };

    const task: TaskSpec = { prompt: 'test', tier: 'standard', requiredCapabilities: [] };
    const result = await delegateWithEscalation(task, [cheapFail, expensiveFail]);

    expect(result.status).toBe('incomplete');
    expect(result.output).toBe('a much longer partial result with more useful content');
    expect(result.escalationLog).toHaveLength(2);
    expect(cheapFail.run).toHaveBeenCalledOnce();
    expect(expensiveFail.run).toHaveBeenCalledOnce();
  });

  it('prefers a real-content attempt over a longer diagnostic-only attempt (cross-status)', async () => {
    // Regression: previously the orchestrator picked by raw output length,
    // which meant a later error-status attempt whose `output` was a long
    // `Sub-agent error: …` diagnostic could beat an earlier `incomplete`
    // with a shorter but genuine scratchpad partial. The two-tier selection
    // must prefer ANY attempt with real content (`outputIsDiagnostic:
    // false`) over any diagnostic-only attempt, regardless of length.
    const realPartial = 'genuine partial work from the scratchpad';
    const longErrorDiagnostic =
      'Sub-agent error: HTTP 500 — provider returned a very long ' +
      'stack trace with lots of noise that makes this string longer ' +
      'than the genuine scratchpad partial above, which would have ' +
      'tricked the old longest-wins selection into discarding it.';

    const cheapIncomplete: Provider = {
      name: 'cheap',
      config: { type: 'codex', model: 'gpt-5-codex' },
      // incomplete with real scratchpad content — outputIsDiagnostic:false
      run: vi.fn().mockResolvedValue(makeMockResult('incomplete', realPartial, false)),
    };
    const expensiveError: Provider = {
      name: 'expensive',
      config: { type: 'codex', model: 'gpt-5-codex' },
      // api_error with empty scratchpad, fell back to error-diagnostic — true
      run: vi.fn().mockResolvedValue({
        ...makeMockResult('api_error', longErrorDiagnostic, true),
        error: 'HTTP 500: provider exploded',
      }),
    };

    // Sanity: the error string really IS longer. If it's not, the test
    // doesn't exercise the bug.
    expect(longErrorDiagnostic.length).toBeGreaterThan(realPartial.length);

    const task: TaskSpec = { prompt: 'test', tier: 'standard', requiredCapabilities: [] };
    const result = await delegateWithEscalation(task, [cheapIncomplete, expensiveError]);

    expect(result.output).toBe(realPartial);
    expect(result.status).toBe('incomplete');
    expect(result.escalationLog).toHaveLength(2);
    expect(result.escalationLog[0].status).toBe('incomplete');
    expect(result.escalationLog[1].status).toBe('api_error');
  });

  it('prefers a real-content incomplete over a longer diagnostic-only incomplete (same status)', async () => {
    // This is the subtler case the first regression did not catch: two
    // `incomplete` attempts where one has real scratchpad content and the
    // other has just the buildXxxIncompleteDiagnostic template text. Old
    // status-only tiering let the diagnostic win on length. The
    // `outputIsDiagnostic` flag fixes this regardless of status match.
    const realShort = 'short but real partial';
    const longDiagnostic =
      '[openai-compatible sub-agent terminated without producing a final ' +
      'answer]\n\nTurns used: 42\nInput tokens: 850000\nOutput tokens: 120\n' +
      'Files read (3): [src/a.ts, src/b.ts, src/c.ts]\nFiles written: []\n' +
      'This template is intentionally long to out-length the real partial.';

    const realProvider: Provider = {
      name: 'real',
      config: { type: 'codex', model: 'gpt-5-codex' },
      run: vi.fn().mockResolvedValue(makeMockResult('incomplete', realShort, false)),
    };
    const diagnosticProvider: Provider = {
      name: 'diag',
      config: { type: 'codex', model: 'gpt-5-codex' },
      run: vi.fn().mockResolvedValue(makeMockResult('incomplete', longDiagnostic, true)),
    };

    expect(longDiagnostic.length).toBeGreaterThan(realShort.length);

    const task: TaskSpec = { prompt: 'test', tier: 'standard', requiredCapabilities: [] };
    const result = await delegateWithEscalation(task, [realProvider, diagnosticProvider]);

    expect(result.output).toBe(realShort);
    expect(result.status).toBe('incomplete');
  });

  it('falls back to the longest diagnostic-only attempt when no real-content attempts exist', async () => {
    // When every attempt is diagnostic-only, the real-content pool is
    // empty, so selection falls through to longest-output across all
    // attempts. Pin this so a future refactor that over-tightens the
    // filter cannot silently drop the fallback.
    const shortErr = 'short';
    const longErr = 'a longer error diagnostic string from a crash';

    const firstErr: Provider = {
      name: 'first',
      config: { type: 'codex', model: 'gpt-5-codex' },
      run: vi.fn().mockResolvedValue(makeMockResult('error', shortErr, true)),
    };
    const secondErr: Provider = {
      name: 'second',
      config: { type: 'codex', model: 'gpt-5-codex' },
      run: vi.fn().mockResolvedValue(makeMockResult('network_error', longErr, true)),
    };

    const task: TaskSpec = { prompt: 'test', tier: 'standard', requiredCapabilities: [] };
    const result = await delegateWithEscalation(task, [firstErr, secondErr]);

    expect(result.output).toBe(longErr);
    expect(result.status).toBe('network_error');
    expect(result.escalationLog).toHaveLength(2);
  });

  it('emits escalation_start between attempts and threads onProgress into runners', async () => {
    const events: ProgressEvent[] = [];
    const onProgress = (e: ProgressEvent) => { events.push(e); };

    const failingProvider: Provider = {
      name: 'cheap',
      config: { type: 'codex', model: 'gpt-5-codex' },
      run: vi.fn().mockResolvedValue(makeMockResult('incomplete', 'partial')),
    };
    const okProvider: Provider = {
      name: 'expensive',
      config: { type: 'codex', model: 'gpt-5-codex' },
      run: vi.fn().mockResolvedValue(makeMockResult('ok', 'complete')),
    };

    const task: TaskSpec = { prompt: 'test', tier: 'standard', requiredCapabilities: [] };
    await delegateWithEscalation(task, [failingProvider, okProvider], { onProgress });

    // Exactly one escalation_start event between the two attempts.
    const escalations = events.filter((e) => e.kind === 'escalation_start');
    expect(escalations).toHaveLength(1);
    const escalation = escalations[0];
    if (escalation.kind !== 'escalation_start') throw new Error('type narrow');
    expect(escalation.previousProvider).toBe('cheap');
    expect(escalation.nextProvider).toBe('expensive');
    expect(escalation.previousReason).toBe('status=incomplete');

    // Callback is threaded into both provider.run options — Tasks 9-11 will
    // emit turn/tool events through it. The orchestrator wraps `onProgress`
    // in a safeSink (try/catch) so runner throws can't corrupt dispatch, so
    // the function reference at the runner site is a wrapper, not the exact
    // callback identity — match any function.
    expect(failingProvider.run).toHaveBeenCalledWith(
      'test',
      expect.objectContaining({ onProgress: expect.any(Function) }),
    );
    expect(okProvider.run).toHaveBeenCalledWith(
      'test',
      expect.objectContaining({ onProgress: expect.any(Function) }),
    );
  });

  it('does not emit escalation_start when the first attempt succeeds', async () => {
    const events: ProgressEvent[] = [];
    const onProgress = (e: ProgressEvent) => { events.push(e); };

    const okProvider: Provider = {
      name: 'cheap',
      config: { type: 'codex', model: 'gpt-5-codex' },
      run: vi.fn().mockResolvedValue(makeMockResult('ok', 'success')),
    };

    const task: TaskSpec = { prompt: 'test', tier: 'standard', requiredCapabilities: [] };
    await delegateWithEscalation(task, [okProvider], { onProgress });

    expect(events.filter((e) => e.kind === 'escalation_start')).toHaveLength(0);
  });

  it('captures onInitialRequest metadata from each attempt into AttemptRecord', async () => {
    // Mock provider that invokes `onInitialRequest` with per-attempt
    // metadata before returning — exactly what a real runner would do
    // after assembling its first request body.
    const makeMockRunner = (
      lengthChars: number,
      sha256: string,
      status: RunResult['status'],
      output = '',
    ) =>
      vi.fn(async (_prompt: string, opts: { onInitialRequest?: (meta: { lengthChars: number; sha256: string }) => void }) => {
        opts.onInitialRequest?.({ lengthChars, sha256 });
        return makeMockResult(status, output);
      });

    const cheap: Provider = {
      name: 'cheap',
      config: { type: 'codex', model: 'gpt-5-codex' },
      run: makeMockRunner(1234, 'deadbeef', 'incomplete', 'partial'),
    };
    const expensive: Provider = {
      name: 'expensive',
      config: { type: 'codex', model: 'gpt-5-codex' },
      run: makeMockRunner(1300, 'cafebabe', 'ok', 'done'),
    };

    const task: TaskSpec = { prompt: 'test', tier: 'standard', requiredCapabilities: [] };
    const result = await delegateWithEscalation(task, [cheap, expensive]);

    expect(result.escalationLog).toHaveLength(2);
    expect(result.escalationLog[0].initialPromptLengthChars).toBe(1234);
    expect(result.escalationLog[0].initialPromptHash).toBe('deadbeef');
    expect(result.escalationLog[1].initialPromptLengthChars).toBe(1300);
    expect(result.escalationLog[1].initialPromptHash).toBe('cafebabe');
  });

  it('defaults AttemptRecord initial-prompt fields to zero/empty when the runner does not call onInitialRequest', async () => {
    // Providers that do not invoke onInitialRequest (pre-Task-12 behavior).
    // The orchestrator must fall through to the zero/empty defaults.
    const silent: Provider = {
      name: 'silent',
      config: { type: 'codex', model: 'gpt-5-codex' },
      run: vi.fn().mockResolvedValue(makeMockResult('ok', 'done')),
    };

    const task: TaskSpec = { prompt: 'test', tier: 'standard', requiredCapabilities: [] };
    const result = await delegateWithEscalation(task, [silent]);

    expect(result.escalationLog[0].initialPromptLengthChars).toBe(0);
    expect(result.escalationLog[0].initialPromptHash).toBe('');
  });

  it('honors explicit pin: does not escalate when task.provider is set', async () => {
    const failingProvider: Provider = {
      name: 'pinned',
      config: { type: 'codex', model: 'gpt-5-codex' },
      run: vi.fn().mockResolvedValue(makeMockResult('incomplete', 'partial')),
    };

    const task: TaskSpec = {
      prompt: 'test',
      tier: 'standard',
      requiredCapabilities: [],
      provider: 'pinned',
    };
    const result = await delegateWithEscalation(task, [failingProvider], {
      explicitlyPinned: true,
    });

    expect(result.status).toBe('incomplete');
    expect(result.output).toBe('partial');
    expect(result.escalationLog).toHaveLength(1);
    expect(result.escalationLog[0].provider).toBe('pinned');
  });
});
