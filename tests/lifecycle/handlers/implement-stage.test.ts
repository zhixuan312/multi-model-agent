import { describe, it, expect, vi, beforeEach } from 'vitest';
import { implementHandler } from '../../../packages/core/src/lifecycle/handlers/implement-stage.js';
import { mockState } from '../../fixtures/lifecycle-state.js';
import type { ImplementPayload } from '../../../packages/core/src/lifecycle/stage-io.js';
import type { TurnResult } from '../../../packages/core/src/types/run-result.js';

// v0.5: the implement stage now calls ctx.getSession(tier).send(prompt, opts)
// directly — no delegateWithEscalation wrapper. The lifecycle-state fixture
// already plumbs ctx.getSession through __mockSessionResponse / __llmAlwaysFails,
// so tests just set those on the state instead of mocking the deleted module.
vi.mock('../../../packages/core/src/bounded-execution/progress-watchdog.js');

function makeMockTurn(opts: {
  output: string;
  turnsUsed: number;
  costUSD: number;
  workerSelfAssessment?: 'done' | 'failed';
  terminationReason?: string;
  filesWritten?: string[];
}): TurnResult {
  return {
    output: opts.output,
    usage: { inputTokens: 0, outputTokens: 0, cachedReadTokens: 0, cachedNonReadTokens: 0 },
    filesWritten: opts.filesWritten ?? [],
    usedShell: false,
    turns: opts.turnsUsed,
    durationMs: 100,
    costUSD: opts.costUSD,
    terminationReason: (opts.terminationReason ?? 'ok') as TurnResult['terminationReason'],
    ...(opts.workerSelfAssessment && { workerSelfAssessment: opts.workerSelfAssessment } as any),
  };
}

describe('implementHandler', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('returns a StageGate<ImplementPayload> on advance', async () => {
    const { startProgressWatchdog } = await import('../../../packages/core/src/bounded-execution/progress-watchdog.js');
    vi.mocked(startProgressWatchdog).mockReturnValue(() => {});

    const state = mockState({
      route: 'delegate',
      task: { id: 't1', prompt: 'do work', brief: { title: 'T', body: 'B' } } as any,
    });
    (state.executionContext as any).__mockSessionResponse = makeMockTurn({
      output: `Worker prose here.\n\`\`\`json\n${JSON.stringify({
        workerSelfAssessment: 'done',
        summary: 'did the thing',
        filesChanged: ['x.ts'],
        findings: [], citations: [], criteriaSucceeded: [], criteriaErrors: [], sourcesUsed: [],
      })}\n\`\`\``,
      turnsUsed: 1,
      costUSD: 0.01,
      workerSelfAssessment: 'done',
    });

    const gate = await implementHandler(state as any);
    expect(gate.outcome).toBe('advance');
    expect((gate.payload as ImplementPayload).workerSelfAssessment).toBe('done');
    expect((gate.payload as ImplementPayload).filesChanged).toEqual(['x.ts']);
    expect((gate.payload as ImplementPayload).findings).toEqual([]);
    expect(gate.telemetry.stageLabel).toBe('implement');
  });

  it('halts on provider transport failure', async () => {
    const { startProgressWatchdog } = await import('../../../packages/core/src/bounded-execution/progress-watchdog.js');
    vi.mocked(startProgressWatchdog).mockReturnValue(() => {});

    const state = mockState({
      route: 'delegate',
      task: { id: 't1', prompt: 'do work', brief: { title: 'T', body: 'B' } } as any,
    });
    (state.executionContext as any).__llmAlwaysFails = true;

    const gate = await implementHandler(state as any);
    expect(gate.outcome).toBe('halt');
    expect(gate.comment).toMatch(/implement status: error/);
  });

  it('advances with workerSelfAssessment=failed when worker emits failed', async () => {
    const { startProgressWatchdog } = await import('../../../packages/core/src/bounded-execution/progress-watchdog.js');
    vi.mocked(startProgressWatchdog).mockReturnValue(() => {});

    const state = mockState({
      route: 'delegate',
      task: { id: 't1', prompt: 'do work', brief: { title: 'T', body: 'B' } } as any,
    });
    (state.executionContext as any).__mockSessionResponse = makeMockTurn({
      output: `\`\`\`json\n${JSON.stringify({
        workerSelfAssessment: 'failed',
        summary: 'gave up',
        filesChanged: [],
        findings: [], citations: [], criteriaSucceeded: [], criteriaErrors: [], sourcesUsed: [],
      })}\n\`\`\``,
      turnsUsed: 1,
      costUSD: 0.01,
      workerSelfAssessment: 'failed',
    });

    const gate = await implementHandler(state as any);
    expect(gate.outcome).toBe('advance');
    expect((gate.payload as ImplementPayload).workerSelfAssessment).toBe('failed');
    expect((gate.payload as ImplementPayload).summary).toBe('gave up');
  });

  it('halts when session throws a sandbox violation', async () => {
    const { startProgressWatchdog } = await import('../../../packages/core/src/bounded-execution/progress-watchdog.js');
    vi.mocked(startProgressWatchdog).mockReturnValue(() => {});

    const state = mockState({
      route: 'delegate',
      task: { id: 't1', prompt: 'do work', brief: { title: 'T', body: 'B' } } as any,
    });
    (state.executionContext as any).getSession = () => ({
      send: async () => { throw new Error('sandbox policy violation: attempted to write outside cwd'); },
      close: async () => {},
    });

    const gate = await implementHandler(state as any);
    expect(gate.outcome).toBe('halt');
    expect(gate.comment).toMatch(/implement status: error/);
  });

  it('fills all ImplementPayload fields with defaults when JSON block missing', async () => {
    const { startProgressWatchdog } = await import('../../../packages/core/src/bounded-execution/progress-watchdog.js');
    vi.mocked(startProgressWatchdog).mockReturnValue(() => {});

    const state = mockState({
      route: 'delegate',
      task: { id: 't1', prompt: 'do work', brief: { title: 'T', body: 'B' } } as any,
    });
    (state.executionContext as any).__mockSessionResponse = makeMockTurn({
      output: 'No structured output — plain text response',
      turnsUsed: 1,
      costUSD: 0.01,
      workerSelfAssessment: 'failed',
    });

    const gate = await implementHandler(state as any);
    expect(gate.outcome).toBe('advance');
    const payload = gate.payload as ImplementPayload;
    expect(payload.workerSelfAssessment).toBe('failed');
    expect(payload.filesChanged).toEqual([]);
    expect(payload.findings).toEqual([]);
    expect(payload.citations).toEqual([]);
    expect(payload.criteriaSucceeded).toEqual([]);
    expect(payload.criteriaErrors).toEqual([]);
    expect(payload.sourcesUsed).toEqual([]);
  });
});
