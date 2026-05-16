import { describe, it, expect, vi, beforeEach } from 'vitest';
import { implementHandler } from '../../../packages/core/src/lifecycle/handlers/task-executor.js';
import { mockState } from '../../fixtures/lifecycle-state.js';
import type { ImplementPayload, RouteName } from '../../../packages/core/src/lifecycle/stage-io.js';
import type { RuntimeRunResult } from '../../../packages/core/src/types.js';

vi.mock('../../../packages/core/src/escalation/delegate-with-escalation.js');
vi.mock('../../../packages/core/src/bounded-execution/progress-watchdog.js');
vi.mock('../../../packages/core/src/lifecycle/handlers/read-route-implementer.js');
vi.mock('../../../packages/core/src/lifecycle/parallel-criteria-routes.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../../packages/core/src/lifecycle/parallel-criteria-routes.js')>();
  return {
    ...actual,
    resolveSubtypeSpec: () => ({
      buildPrefix: () => 'mock prefix',
      criteria: [{ id: 'c1', label: 'criterion 1' }],
      buildSuffix: (_c: { id: string }) => 'mock suffix',
    }),
    isReadOnlyRoute: (route: string) => ['audit', 'review', 'debug', 'investigate', 'explore'].includes(route),
  };
});

const READ_ROUTES: RouteName[] = ['audit', 'review', 'debug', 'investigate', 'explore'];

function makeMockResult(turn: {
  kind: 'ok'; output: string; costUSD: number; turnsUsed: number; terminationReason: string;
}): RuntimeRunResult {
  return {
    output: turn.output,
    status: 'ok',
    usage: { inputTokens: 0, outputTokens: 0, cachedReadTokens: 0, cachedNonReadTokens: 0 },
    turns: turn.turnsUsed,
    filesRead: [],
    filesWritten: [],
    toolCalls: [],
    outputIsDiagnostic: false,
    escalationLog: [],
    cost: { costUSD: turn.costUSD },
    durationMs: 100,
    workerStatus: 'done',
  };
}

describe('implementHandler', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('returns a StageGate<ImplementPayload> on advance', async () => {
    const { delegateWithEscalation } = await import('../../../packages/core/src/escalation/delegate-with-escalation.js');
    const { startProgressWatchdog } = await import('../../../packages/core/src/bounded-execution/progress-watchdog.js');

    vi.mocked(delegateWithEscalation).mockResolvedValueOnce(makeMockResult({
      kind: 'ok',
      output: `Worker prose here.\n\`\`\`json\n${JSON.stringify({
        workerSelfAssessment: 'done',
        summary: 'did the thing',
        filesChanged: ['x.ts'],
        findings: [], citations: [], criteriaSucceeded: [], criteriaErrors: [], sourcesUsed: [],
      })}\n\`\`\``,
      costUSD: 0.01,
      turnsUsed: 1,
      terminationReason: 'ok',
    }));
    vi.mocked(startProgressWatchdog).mockReturnValue(() => {});

    const state = mockState({
      route: 'delegate',
      task: { id: 't1', prompt: 'do work', brief: { title: 'T', body: 'B' } } as any,
    });

    const gate = await implementHandler(state as any);
    expect(gate.outcome).toBe('advance');
    expect((gate.payload as ImplementPayload).workerSelfAssessment).toBe('done');
    expect((gate.payload as ImplementPayload).filesChanged).toEqual(['x.ts']);
    expect((gate.payload as ImplementPayload).findings).toEqual([]);
    expect(gate.telemetry.stageLabel).toBe('implement');
  });

  it('halts on provider transport failure', async () => {
    const { delegateWithEscalation } = await import('../../../packages/core/src/escalation/delegate-with-escalation.js');
    const { startProgressWatchdog } = await import('../../../packages/core/src/bounded-execution/progress-watchdog.js');

    vi.mocked(delegateWithEscalation).mockRejectedValueOnce(new Error('5xx error after 3 retries'));
    vi.mocked(startProgressWatchdog).mockReturnValue(() => {});

    const state = mockState({
      route: 'delegate',
      task: { id: 't1', prompt: 'do work', brief: { title: 'T', body: 'B' } } as any,
    });

    const gate = await implementHandler(state as any);
    expect(gate.outcome).toBe('halt');
    expect(gate.comment).toMatch(/implement status: error/);
  });

  it('advances with workerSelfAssessment=failed when worker emits failed', async () => {
    const { delegateWithEscalation } = await import('../../../packages/core/src/escalation/delegate-with-escalation.js');
    const { startProgressWatchdog } = await import('../../../packages/core/src/bounded-execution/progress-watchdog.js');

    const result = makeMockResult({
      kind: 'ok',
      output: `\`\`\`json\n${JSON.stringify({
        workerSelfAssessment: 'failed',
        summary: 'gave up',
        filesChanged: [],
        findings: [], citations: [], criteriaSucceeded: [], criteriaErrors: [], sourcesUsed: [],
      })}\n\`\`\``,
      costUSD: 0.01,
      turnsUsed: 1,
      terminationReason: 'ok',
    });
    result.workerStatus = 'failed';
    vi.mocked(delegateWithEscalation).mockResolvedValueOnce(result);
    vi.mocked(startProgressWatchdog).mockReturnValue(() => {});

    const state = mockState({
      route: 'delegate',
      task: { id: 't1', prompt: 'do work', brief: { title: 'T', body: 'B' } } as any,
    });

    const gate = await implementHandler(state as any);
    expect(gate.outcome).toBe('advance');
    expect((gate.payload as ImplementPayload).workerSelfAssessment).toBe('failed');
    expect((gate.payload as ImplementPayload).summary).toBe('gave up');
  });

  it('halts on cost_cap_exceeded_without_output when status not ok', async () => {
    const { delegateWithEscalation } = await import('../../../packages/core/src/escalation/delegate-with-escalation.js');
    const { startProgressWatchdog } = await import('../../../packages/core/src/bounded-execution/progress-watchdog.js');

    vi.mocked(delegateWithEscalation).mockResolvedValueOnce({
      output: 'Worker ran out of budget and produced no structured output',
      status: 'error',
      usage: { inputTokens: 0, outputTokens: 0, cachedReadTokens: 0, cachedNonReadTokens: 0 },
      turns: 50,
      filesRead: [],
      filesWritten: [],
      toolCalls: [],
      outputIsDiagnostic: true,
      escalationLog: [],
      cost: { costUSD: 5.0 },
      durationMs: 100,
      workerStatus: 'failed',
    });
    vi.mocked(startProgressWatchdog).mockReturnValue(() => {});

    const state = mockState({
      route: 'delegate',
      task: { id: 't1', prompt: 'do work', brief: { title: 'T', body: 'B' } } as any,
    });

    const gate = await implementHandler(state as any);
    expect(gate.outcome).toBe('halt');
    expect(gate.comment).toMatch(/implement status: error/);
  });

  it('advances on cost_cap when structured output is present', async () => {
    const { delegateWithEscalation } = await import('../../../packages/core/src/escalation/delegate-with-escalation.js');
    const { startProgressWatchdog } = await import('../../../packages/core/src/bounded-execution/progress-watchdog.js');

    vi.mocked(delegateWithEscalation).mockResolvedValueOnce(makeMockResult({
      kind: 'ok',
      output: `Some work done.\n\`\`\`json\n${JSON.stringify({
        workerSelfAssessment: 'done',
        summary: 'done with partial output',
        filesChanged: ['partial.ts'],
        findings: [], citations: [], criteriaSucceeded: [], criteriaErrors: [], sourcesUsed: [],
      })}\n\`\`\``,
      costUSD: 5.0,
      turnsUsed: 50,
      terminationReason: 'cap_exhausted',
    }));
    vi.mocked(startProgressWatchdog).mockReturnValue(() => {});

    const state = mockState({
      route: 'delegate',
      task: { id: 't1', prompt: 'do work', brief: { title: 'T', body: 'B' } } as any,
    });

    const gate = await implementHandler(state as any);
    expect(gate.outcome).toBe('advance');
    expect((gate.payload as ImplementPayload).filesChanged).toEqual(['partial.ts']);
  });

  it('reads route: fills findings from runReadRouteImplementer output', async () => {
    const { runReadRouteImplementer } = await import('../../../packages/core/src/lifecycle/handlers/read-route-implementer.js');
    const { startProgressWatchdog } = await import('../../../packages/core/src/bounded-execution/progress-watchdog.js');

    vi.mocked(runReadRouteImplementer).mockResolvedValueOnce({
      findings: [
        { id: 'F1', severity: 'high', category: 'correctness', claim: 'missing null check', evidence: 'foo()', source: 'implementer' },
        { id: 'F2', severity: 'medium', category: 'style', claim: 'naming inconsistency', evidence: 'bar', source: 'implementer' },
      ],
      criteriaErrors: [],
      usage: { inputTokens: 100, outputTokens: 200, cachedReadTokens: 0, cachedNonReadTokens: 0 },
      turns: 1,
      costUSD: 0.02,
      durationMs: 500,
      synthesizedOutput: 'criterion 1 narrative...',
    });
    vi.mocked(startProgressWatchdog).mockReturnValue(() => {});

    const state = mockState({
      route: 'audit',
      toolCategory: 'read_only',
      task: { id: 't1', prompt: 'audit this doc', brief: { title: 'T', body: 'B' }, subtype: 'default' } as any,
    });

    const gate = await implementHandler(state as any);
    expect(gate.outcome).toBe('advance');
    const payload = gate.payload as ImplementPayload;
    expect(payload.findings).toHaveLength(2);
    expect(payload.findings[0].id).toBe('F1');
    expect(payload.findings[1].id).toBe('F2');
    expect(payload.criteriaSucceeded.length).toBeGreaterThanOrEqual(0);
  });

  it('halts when session throws a sandbox violation', async () => {
    const { delegateWithEscalation } = await import('../../../packages/core/src/escalation/delegate-with-escalation.js');
    const { startProgressWatchdog } = await import('../../../packages/core/src/bounded-execution/progress-watchdog.js');

    vi.mocked(delegateWithEscalation).mockRejectedValueOnce(new Error('sandbox policy violation: attempted to write outside cwd'));
    vi.mocked(startProgressWatchdog).mockReturnValue(() => {});

    const state = mockState({
      route: 'delegate',
      task: { id: 't1', prompt: 'do work', brief: { title: 'T', body: 'B' } } as any,
    });

    const gate = await implementHandler(state as any);
    expect(gate.outcome).toBe('halt');
    expect(gate.comment).toMatch(/implement status: error/);
  });

  it('fills all ImplementPayload fields with defaults when JSON block missing', async () => {
    const { delegateWithEscalation } = await import('../../../packages/core/src/escalation/delegate-with-escalation.js');
    const { startProgressWatchdog } = await import('../../../packages/core/src/bounded-execution/progress-watchdog.js');

    const result = makeMockResult({
      kind: 'ok',
      output: 'No structured output — plain text response',
      costUSD: 0.01,
      turnsUsed: 1,
      terminationReason: 'ok',
    });
    result.workerStatus = 'failed'; // no structured output means worker failed to produce output
    vi.mocked(delegateWithEscalation).mockResolvedValueOnce(result);
    vi.mocked(startProgressWatchdog).mockReturnValue(() => {});

    const state = mockState({
      route: 'delegate',
      task: { id: 't1', prompt: 'do work', brief: { title: 'T', body: 'B' } } as any,
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