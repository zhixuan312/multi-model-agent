import { describe, it, expect, vi, beforeEach } from 'bun:test';
import { mockState } from '../../fixtures/lifecycle-state.js';
import type { ImplementPayload, RouteName } from '../../../packages/core/src/lifecycle/stage-io.js';
import type { TurnResult } from '../../../packages/core/src/types/run-result.js';
import { implementHandler } from '../../../packages/core/src/lifecycle/handlers/implement-stage.js';

// v0.5: the implement stage calls ctx.getSession(tier).send(prompt, opts) directly;
// the write path is driven by the lifecycle-state fixture's ctx.getSession plumbing
// (__mockSessionResponse / __llmAlwaysFails). The deep deps (watchdog + read-route
// dispatch/criteria) are injected via implementHandler's deps param rather than
// vi.mock — under Bun mock.module is sticky/process-global and leaked these stubs
// into later tests (warm-followup, runReadRouteImplementer, etc.).
const mockStartWatchdog = vi.fn(() => () => {});
const mockRecordPostHoc = vi.fn(async () => {});
const mockRunReadRoute = vi.fn();
const implDeps = {
  startProgressWatchdog: mockStartWatchdog,
  recordPostHocSignals: mockRecordPostHoc,
  runReadRouteImplementer: mockRunReadRoute,
  resolveSubtypeSpec: () => ({
    buildPrefix: () => 'mock prefix',
    criteria: [{ id: 'c1', label: 'criterion 1' }],
    buildSuffix: (_c: { id: string }) => 'mock suffix',
    semantics: {
      goalLine: 'mock goal',
      emptyOutcomeLine: 'mock empty',
      findingMeaningParagraph: 'mock finding',
      severityMeanings: { critical: 'c', high: 'h', medium: 'm', low: 'l' },
      mustEmitAtLeastOne: false,
      legalOutcomes: ['found', 'clean'] as const,
    },
  }),
  isReadOnlyRoute: (route: string) => ['audit', 'review', 'debug', 'investigate', 'explore'].includes(route),
} as any;
const runImpl = (state: any) => implementHandler(state, implDeps);

const READ_ROUTES: RouteName[] = ['audit', 'review', 'debug', 'investigate', 'explore'];

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

    const gate = await runImpl(state as any);
    expect(gate.outcome).toBe('advance');
    expect((gate.payload as ImplementPayload).workerSelfAssessment).toBe('done');
    expect((gate.payload as ImplementPayload).filesChanged).toEqual(['x.ts']);
    expect((gate.payload as ImplementPayload).findings).toEqual([]);
    expect(gate.telemetry.stageLabel).toBe('implement');
  });

  it('halts on provider transport failure', async () => {

    const state = mockState({
      route: 'delegate',
      task: { id: 't1', prompt: 'do work', brief: { title: 'T', body: 'B' } } as any,
    });
    (state.executionContext as any).__llmAlwaysFails = true;

    const gate = await runImpl(state as any);
    expect(gate.outcome).toBe('halt');
    expect(gate.comment).toMatch(/implement status: error/);
  });

  it('advances with workerSelfAssessment=failed when worker emits failed', async () => {

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

    const gate = await runImpl(state as any);
    expect(gate.outcome).toBe('advance');
    expect((gate.payload as ImplementPayload).workerSelfAssessment).toBe('failed');
    expect((gate.payload as ImplementPayload).summary).toBe('gave up');
  });

  it('reads route: fills findings from runReadRouteImplementer output', async () => {

    mockRunReadRoute.mockResolvedValueOnce({
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
      findingsOutcome: 'found',
      findingsOutcomeReason: null,
    });

    const state = mockState({
      route: 'audit',
      toolCategory: 'read_only',
      task: { id: 't1', prompt: 'audit this doc', readTarget: 'audit this doc', brief: { title: 'T', body: 'B' }, subtype: 'default' } as any,
    });

    const gate = await runImpl(state as any);
    expect(gate.outcome).toBe('advance');
    const payload = gate.payload as ImplementPayload;
    expect(payload.findings).toHaveLength(2);
    expect(payload.findings[0].id).toBe('F1');
    expect(payload.findings[1].id).toBe('F2');
    expect(payload.criteriaSucceeded.length).toBeGreaterThanOrEqual(0);
  });

  it('halts when session throws a sandbox violation', async () => {

    const state = mockState({
      route: 'delegate',
      task: { id: 't1', prompt: 'do work', brief: { title: 'T', body: 'B' } } as any,
    });
    (state.executionContext as any).getSession = () => ({
      send: async () => { throw new Error('sandbox policy violation: attempted to write outside cwd'); },
      close: async () => {},
    });

    const gate = await runImpl(state as any);
    expect(gate.outcome).toBe('halt');
    expect(gate.comment).toMatch(/implement status: error/);
  });

  it('fills all ImplementPayload fields with defaults when JSON block missing', async () => {

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

    const gate = await runImpl(state as any);
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

// Unused-but-imported reference to satisfy linters.
void READ_ROUTES;
