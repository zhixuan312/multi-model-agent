import { describe, expect, it, vi } from 'vitest';
import type { ExecutionContext } from '../../packages/core/src/lifecycle/executors/types.js';
import type { MultiModelConfig, Provider, RunResult } from '../../packages/core/src/types.js';
import { EventEmitter } from '../../packages/core/src/events/event-emitter.js';
import type { EventSink, EventType } from '../../packages/core/src/events/event-emitter.js';

const providerState = vi.hoisted(() => ({ activeProvider: undefined as Provider | undefined }));

vi.mock('@zhixuan92/multi-model-agent-core/providers/provider-factory', () => ({
  createProvider: () => providerState.activeProvider,
}));

import { executeExplore, type ExploreExecutorInput } from '../../packages/core/src/lifecycle/executors/explore.js';
import { mkdtempSync, realpathSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  capExhaustingProvider,
} from '../contract/fixtures/mock-providers.js';

const TEST_BATCH_ID = '550e8400-e29b-41d4-a716-446655440000';

function okResult(output: string): RunResult {
  return {
    output,
    status: 'ok',
    usage: { inputTokens: 10, outputTokens: 20, totalTokens: 30, costUSD: 0.001 },
    turns: 1,
    filesRead: [],
    filesWritten: [],
    toolCalls: [],
    outputIsDiagnostic: false,
    escalationLog: [{ provider: 'mock', status: 'ok', turns: 1, inputTokens: 10, outputTokens: 20, costUSD: 0.001, initialPromptLengthChars: 0, initialPromptHash: '' }],
    durationMs: 0,
    directoriesListed: [],
    workerStatus: 'done',
    terminationReason: { cause: 'finished' as const, turnsUsed: 1, hasFileArtifacts: false, usedShell: false, workerSelfAssessment: 'done', wasPromoted: false },
  } as unknown as RunResult;
}

const STUB_CONFIG = { type: 'openai-compatible' as const, baseUrl: 'http://mock.local', apiKey: 'mock', model: 'mock-model' };

/**
 * Multi-call provider: returns results from a sequence, one per `run()` call.
 * Falls back to the last item if the sequence is exhausted.
 */
function sequencedProvider(items: Array<{ run: () => Promise<RunResult> }>): Provider {
  let idx = 0;
  return {
    name: 'mock-seq',
    config: STUB_CONFIG,
    async run(_prompt: string): Promise<RunResult> {
      const item = items[idx] ?? items[items.length - 1];
      idx++;
      return item.run();
    },
  };
}

function baseConfig(): MultiModelConfig {
  return {
    agents: {
      standard: { type: 'openai-compatible', model: 'std', baseUrl: 'https://ex.invalid/v1' },
      complex: { type: 'openai-compatible', model: 'cpx', baseUrl: 'https://ex2.invalid/v1' },
    },
    defaults: { tools: 'readonly', timeoutMs: 60_000, maxCostUSD: 1, sandboxPolicy: 'cwd-only' },
    research: {
      brave: { apiKeys: [] },
      fetch: {},
      builtinAdapters: { arxiv: true, semanticScholar: true, githubSearch: true, genericRss: true },
      userSources: [],
      fetchAllowlistExtra: [],
    },
  } as unknown as MultiModelConfig;
}

function makeCtx(provider: Provider, overrides?: Partial<ExecutionContext>): { ctx: ExecutionContext } {
  const cwd = realpathSync(mkdtempSync(join(tmpdir(), 'expl-rl-')));
  providerState.activeProvider = provider;
  const ctx: ExecutionContext = {
    projectContext: { cwd, contextBlockStore: { get: () => undefined, register: () => ({ id: 'x' }) } as any, lastActivityAt: Date.now() } as any,
    config: baseConfig(),
    logger: { event: () => {}, emit: () => {}, child: () => ({ event: () => {}, emit: () => {} } as any) } as any,
    contextBlockStore: { get: () => undefined, register: () => ({ id: 'x' }) } as any,
    batchId: TEST_BATCH_ID,
    ...overrides,
  };
  return { ctx };
}

function defaultArgs(): ExploreExecutorInput {
  return {
    input: {
      currentContext: 'I am building a momentum strategy on daily OHLC.',
      explorationQuestion: 'What other signal classes complement momentum?',
      anchors: [],
      contextBlockIds: [],
    },
    resolvedContextBlocks: [],
    canonicalizedAnchors: [],
    relativeAnchorsForPrompt: [],
  };
}

/** Creates an EventEmitter that collects all events into an array for assertions. */
function collectingBus(): { bus: EventEmitter; events: EventType[] } {
  const events: EventType[] = [];
  const sink: EventSink = {
    name: 'test-collector',
    emit: (e) => { events.push(e); },
  };
  return { bus: new EventEmitter([sink]), events };
}

const internalOk = '## Reusable components\n1. src/signal.ts:10 — signal base class\n## Baseline-defining anchors\n2. src/momentum.ts:45 — current momentum\n## Adjacent prior art\n3. src/mean-reversion.ts:88 — old MR experiment\n## Unresolved\n';
const externalOk = '## Findings\n1. arxiv:2401.12345 — vol-targeting improves momentum\n## Sources used\n| arxiv | 1q | 1r |';

function synthWithThreads(n: number): string {
  const parts = ['## Context recap\nRecap.\n'];
  for (let i = 1; i <= n; i++) {
    parts.push(`## Thread ${i}: Thread ${i}\nSummary ${i}.\n**Internal anchors:**\n- src/a.ts:1\n**External sources:**\n- arxiv:${i}\n**Divergence axis:** axis ${i}\n`);
  }
  parts.push('## Recommended next step\nThread 1.\n');
  return parts.join('\n');
}

// ===========================================================================
// Core flow tests
// ===========================================================================

describe('executeExplore reviewed-execution parser + envelope flow', () => {
  it('full happy path — 3 tasks, 3 threads, done', async () => {
    const provider = sequencedProvider([
      { run: async () => okResult(internalOk) },
      { run: async () => okResult(externalOk) },
      { run: async () => okResult(synthWithThreads(3)) },
    ]);
    const { ctx } = makeCtx(provider);
    const out = await executeExplore(ctx, defaultArgs());
    expect(out.headline).toBe('explore: 3/3 tasks complete; 3 threads');
    expect(out.results).toHaveLength(3);
    const synthResult = (out.results as any[])[2];
    expect(synthResult.workerStatus).toBe('done');
    expect(synthResult.structuredReport.explore.threads).toHaveLength(3);
    expect(synthResult.structuredReport.explore.recommendedNextStep).toBeTruthy();
  });

  it('internal fails → degraded inputs, synthesizer still produces threads', async () => {
    const provider = sequencedProvider([
      { run: async () => { throw new Error('internal crash'); } },
      { run: async () => okResult(externalOk) },
      { run: async () => okResult(synthWithThreads(1)) },
    ]);
    const { ctx } = makeCtx(provider);
    const out = await executeExplore(ctx, defaultArgs());
    expect(out.headline).toContain('degraded inputs');
    expect(out.headline).toContain('1 threads');
    expect(out.results).toHaveLength(3);
    const synthResult = (out.results as any[])[2];
    expect(synthResult.structuredReport.explore.threads).toHaveLength(1);
  });

  it('both internal and external fail → synthesizer fails', async () => {
    const provider = sequencedProvider([
      { run: async () => { throw new Error('internal crash'); } },
      { run: async () => { throw new Error('external crash'); } },
      { run: async () => { throw new Error('synthesizer crash'); } },
    ]);
    const { ctx } = makeCtx(provider);
    const out = await executeExplore(ctx, defaultArgs());
    expect(out.headline).toBe('explore: synthesizer failed; worker outputs preserved');
    const synthResult = (out.results as any[])[2];
    expect(synthResult.workerStatus).toBe('failed');
  });

  it('synthesizer turn cap with 1 thread → done_with_concerns + turn_cap', async () => {
    const capProv = capExhaustingProvider({ kind: 'turn', partialOutput: synthWithThreads(1) });
    const provider = sequencedProvider([
      { run: async () => okResult(internalOk) },
      { run: async () => okResult(externalOk) },
      { run: () => capProv.run('') },
    ]);
    const { ctx } = makeCtx(provider);
    const out = await executeExplore(ctx, defaultArgs());
    const synthResult = (out.results as any[])[2];
    expect(synthResult.workerStatus).toBe('done_with_concerns');
    expect(synthResult.incompleteReason).toBe('turn_cap');
    expect(synthResult.structuredReport.explore.diagnostics.insufficientThreads).toBe(true);
  });

  it('empty synth output → no_structured_report, done', async () => {
    const provider = sequencedProvider([
      { run: async () => okResult(internalOk) },
      { run: async () => okResult(externalOk) },
      { run: async () => okResult('') },
    ]);
    const { ctx } = makeCtx(provider);
    const out = await executeExplore(ctx, defaultArgs());
    const synthResult = (out.results as any[])[2];
    expect(synthResult.workerStatus).toBe('done');
    expect(synthResult.structuredReport?.explore).toBeUndefined();
    expect(out.headline).toBe('explore: 3/3 tasks complete; 0 threads');
  });

  it('synth output with 5 threads → all parsed', async () => {
    const provider = sequencedProvider([
      { run: async () => okResult(internalOk) },
      { run: async () => okResult(externalOk) },
      { run: async () => okResult(synthWithThreads(5)) },
    ]);
    const { ctx } = makeCtx(provider);
    const out = await executeExplore(ctx, defaultArgs());
    expect(out.headline).toBe('explore: 3/3 tasks complete; 5 threads');
    const synthResult = (out.results as any[])[2];
    expect(synthResult.structuredReport.explore.threads).toHaveLength(5);
    expect(synthResult.workerStatus).toBe('done');
  });

  it('malformed synth report (0 valid threads) → no_structured_report', async () => {
    const provider = sequencedProvider([
      { run: async () => okResult(internalOk) },
      { run: async () => okResult(externalOk) },
      { run: async () => okResult('Just some random text, no valid thread structure here.') },
    ]);
    const { ctx } = makeCtx(provider);
    const out = await executeExplore(ctx, defaultArgs());
    const synthResult = (out.results as any[])[2];
    expect(synthResult.workerStatus).toBe('done');
    expect(synthResult.structuredReport?.explore).toBeUndefined();
  });

  it('cost cap on synthesizer → done_with_concerns + cost_cap', async () => {
    const capProv = capExhaustingProvider({ kind: 'cost', partialOutput: synthWithThreads(1) });
    const provider = sequencedProvider([
      { run: async () => okResult(internalOk) },
      { run: async () => okResult(externalOk) },
      { run: () => capProv.run('') },
    ]);
    const { ctx } = makeCtx(provider);
    const out = await executeExplore(ctx, defaultArgs());
    const synthResult = (out.results as any[])[2];
    expect(synthResult.workerStatus).toBe('done_with_concerns');
    expect(synthResult.incompleteReason).toBe('cost_cap');
  });

  it('wall_clock cap on synthesizer → done_with_concerns + timeout', async () => {
    const capProv = capExhaustingProvider({ kind: 'wall_clock', partialOutput: synthWithThreads(1) });
    const provider = sequencedProvider([
      { run: async () => okResult(internalOk) },
      { run: async () => okResult(externalOk) },
      { run: () => capProv.run('') },
    ]);
    const { ctx } = makeCtx(provider);
    const out = await executeExplore(ctx, defaultArgs());
    const synthResult = (out.results as any[])[2];
    expect(synthResult.workerStatus).toBe('done_with_concerns');
    expect(synthResult.incompleteReason).toBe('timeout');
  });

  it('duplicate thread index → 3 threads survive, done_with_concerns + threads_dropped', async () => {
    const dupThreads = `## Thread 1: First\nSummary A.\n**Internal anchors:**\n- src/a.ts:1\n**External sources:**\n- arxiv:1\n**Divergence axis:** axis A\n\n## Thread 1: Duplicate\nSummary B.\n**Internal anchors:**\n- src/b.ts:1\n**External sources:**\n- arxiv:2\n**Divergence axis:** axis B\n\n## Thread 2: Valid\nSummary C.\n**Internal anchors:**\n- src/c.ts:1\n**External sources:**\n- arxiv:3\n**Divergence axis:** axis C\n\n## Thread 3: Also Valid\nSummary D.\n**Internal anchors:**\n- src/d.ts:1\n**External sources:**\n- arxiv:4\n**Divergence axis:** axis D\n`;
    const provider = sequencedProvider([
      { run: async () => okResult(internalOk) },
      { run: async () => okResult(externalOk) },
      { run: async () => okResult(dupThreads) },
    ]);
    const { ctx } = makeCtx(provider);
    const out = await executeExplore(ctx, defaultArgs());
    const synthResult = (out.results as any[])[2];
    expect(synthResult.workerStatus).toBe('done_with_concerns');
    expect(synthResult.incompleteReason).toBe('threads_dropped');
    expect(synthResult.structuredReport.explore.threads).toHaveLength(3);
    expect(synthResult.structuredReport.explore.diagnostics.droppedThreadDiagnostics).toHaveLength(1);
  });

  it('batchTimings computed across all 3 sub-results', async () => {
    const provider = sequencedProvider([
      { run: async () => okResult(internalOk) },
      { run: async () => okResult(externalOk) },
      { run: async () => okResult(synthWithThreads(3)) },
    ]);
    const { ctx } = makeCtx(provider);
    const out = await executeExplore(ctx, defaultArgs());
    expect(out.batchTimings).not.toEqual({ kind: 'not_applicable' });
    if (out.batchTimings && typeof out.batchTimings === 'object' && 'wallClockMs' in out.batchTimings) {
      expect(out.batchTimings.wallClockMs).toBeGreaterThan(0);
    }
  });

  it('costSummary aggregates across all 3 sub-results', async () => {
    const provider = sequencedProvider([
      { run: async () => okResult(internalOk) },
      { run: async () => okResult(externalOk) },
      { run: async () => okResult(synthWithThreads(3)) },
    ]);
    const { ctx } = makeCtx(provider);
    const out = await executeExplore(ctx, defaultArgs());
    expect(out.costSummary).not.toEqual({ kind: 'not_applicable' });
  });
});

// ===========================================================================
// Worker degradation edge cases
//
// These use the throwing pattern (matching the existing 'internal fails'
// test) to bypass lifecycle-escalation so the executor's .catch() path
// creates fallback results with workerStatus: 'failed'.  The isFailed()
// function covers all degraded statuses (error, api_error, network_error,
// unavailable, api_aborted, timeout, cost_exceeded, brief_too_vague,
// incomplete); these tests verify the executor treats a thrown/crashed
// worker as degraded and emits the correct events.
// ===========================================================================

describe('executeExplore worker degradation edge cases', () => {
  it('internal worker throws → degraded internal, synth succeeds', async () => {
    const provider = sequencedProvider([
      { run: async () => { throw new Error('internal crash'); } },
      { run: async () => okResult(externalOk) },
      { run: async () => okResult(synthWithThreads(2)) },
    ]);
    const { ctx } = makeCtx(provider);
    const out = await executeExplore(ctx, defaultArgs());
    expect(out.headline).toContain('degraded inputs');
    expect((out.results as any[])[0].workerStatus).toBe('failed');
  });

  it('external worker throws → degraded external, synth succeeds', async () => {
    const provider = sequencedProvider([
      { run: async () => okResult(internalOk) },
      { run: async () => { throw new Error('external crash'); } },
      { run: async () => okResult(synthWithThreads(1)) },
    ]);
    const { ctx } = makeCtx(provider);
    const out = await executeExplore(ctx, defaultArgs());
    expect(out.headline).toContain('degraded inputs');
    expect((out.results as any[])[1].workerStatus).toBe('failed');
  });

  it('both internal and external throw → synthesizer fails', async () => {
    const provider = sequencedProvider([
      { run: async () => { throw new Error('internal crash'); } },
      { run: async () => { throw new Error('external crash'); } },
      { run: async () => { throw new Error('synth crash'); } },
    ]);
    const { ctx } = makeCtx(provider);
    const out = await executeExplore(ctx, defaultArgs());
    expect(out.headline).toBe('explore: synthesizer failed; worker outputs preserved');
  });

  it('internal worker returns error status → degraded', async () => {
    // Use a provider that throws so the .catch() path creates a fallback
    // result with status 'error'.  This exercises isFailed() for the 'error'
    // status without going through lifecycle escalation.
    const provider = sequencedProvider([
      { run: async () => { throw new Error('worker error'); } },
      { run: async () => okResult(externalOk) },
      { run: async () => okResult(synthWithThreads(2)) },
    ]);
    const { ctx } = makeCtx(provider);
    const out = await executeExplore(ctx, defaultArgs());
    expect(out.headline).toContain('degraded inputs');
    const internalResult = (out.results as any[])[0];
    expect(internalResult.status).toBe('error');
    expect(internalResult.workerStatus).toBe('failed');
  });
});

// ===========================================================================
// EventEmitter integration tests
// ===========================================================================

describe('executeExplore EventEmitter integration', () => {
  it('emits all 6 explore batch events in happy path', async () => {
    const provider = sequencedProvider([
      { run: async () => okResult(internalOk) },
      { run: async () => okResult(externalOk) },
      { run: async () => okResult(synthWithThreads(3)) },
    ]);
    const { bus, events } = collectingBus();
    const { ctx } = makeCtx(provider, { bus, batchId: TEST_BATCH_ID } as Partial<ExecutionContext>);

    const out = await executeExplore(ctx, defaultArgs());
    expect(out.headline).toBe('explore: 3/3 tasks complete; 3 threads');

    const eventNames = events.map(e => e.event);
    expect(eventNames).toContain('explore_parallel_start');
    expect(eventNames).toContain('explore_parallel_end');
    expect(eventNames).toContain('explore_synthesize_start');
    expect(eventNames).toContain('explore_synthesize_end');

    const parallelEnd = events.find(e => e.event === 'explore_parallel_end') as any;
    expect(parallelEnd).toBeDefined();
    expect(parallelEnd.internalOk).toBe(true);
    expect(parallelEnd.externalOk).toBe(true);

    const synthEnd = events.find(e => e.event === 'explore_synthesize_end') as any;
    expect(synthEnd).toBeDefined();
    expect(synthEnd.threadCount).toBe(3);
    expect(synthEnd.recommendedNextStep).toBe(true);
  });

  it('emits unavailable events when workers degrade', async () => {
    const provider = sequencedProvider([
      { run: async () => { throw new Error('internal crash'); } },
      { run: async () => okResult(externalOk) },
      { run: async () => okResult(synthWithThreads(1)) },
    ]);
    const { bus, events } = collectingBus();
    const { ctx } = makeCtx(provider, { bus, batchId: TEST_BATCH_ID } as Partial<ExecutionContext>);

    await executeExplore(ctx, defaultArgs());

    const eventNames = events.map(e => e.event);
    expect(eventNames).toContain('explore_internal_unavailable');
    expect(eventNames).not.toContain('explore_external_unavailable');

    const parallelEnd = events.find(e => e.event === 'explore_parallel_end') as any;
    expect(parallelEnd.internalOk).toBe(false);
    expect(parallelEnd.externalOk).toBe(true);

    const synthStart = events.find(e => e.event === 'explore_synthesize_start') as any;
    expect(synthStart.internalAvailable).toBe(false);
    expect(synthStart.externalAvailable).toBe(true);
  });

  it('emits both unavailable events when both workers fail', async () => {
    const provider = sequencedProvider([
      { run: async () => { throw new Error('internal crash'); } },
      { run: async () => { throw new Error('external crash'); } },
      { run: async () => { throw new Error('synth crash'); } },
    ]);
    const { bus, events } = collectingBus();
    const { ctx } = makeCtx(provider, { bus, batchId: TEST_BATCH_ID } as Partial<ExecutionContext>);

    await executeExplore(ctx, defaultArgs());

    const eventNames = events.map(e => e.event);
    expect(eventNames).toContain('explore_internal_unavailable');
    expect(eventNames).toContain('explore_external_unavailable');
  });

  it('events have batchId and ts fields', async () => {
    const provider = sequencedProvider([
      { run: async () => okResult(internalOk) },
      { run: async () => okResult(externalOk) },
      { run: async () => okResult(synthWithThreads(3)) },
    ]);
    const { bus, events } = collectingBus();
    const { ctx } = makeCtx(provider, { bus, batchId: TEST_BATCH_ID } as Partial<ExecutionContext>);

    await executeExplore(ctx, defaultArgs());

    for (const evt of events) {
      expect((evt as any).batchId).toBe(TEST_BATCH_ID);
      expect((evt as any).ts).toBeDefined();
    }
  });

  it('synthesize_end reports no structured report when output is empty', async () => {
    const provider = sequencedProvider([
      { run: async () => okResult(internalOk) },
      { run: async () => okResult(externalOk) },
      { run: async () => okResult('') },
    ]);
    const { bus, events } = collectingBus();
    const { ctx } = makeCtx(provider, { bus, batchId: TEST_BATCH_ID } as Partial<ExecutionContext>);

    await executeExplore(ctx, defaultArgs());

    const synthEnd = events.find(e => e.event === 'explore_synthesize_end') as any;
    expect(synthEnd).toBeDefined();
    expect(synthEnd.threadCount).toBe(0);
    expect(synthEnd.recommendedNextStep).toBe(false);
  });
});
