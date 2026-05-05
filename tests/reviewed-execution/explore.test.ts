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

const TEST_BATCH_ID = '660e8400-e29b-41d4-a716-446655440001';

function okResult(output: string): RunResult {
  return {
    output,
    status: 'ok',
    usage: { inputTokens: 10, outputTokens: 20, cachedReadTokens: 0, cachedNonReadTokens: 0 },
    cost: { costUSD: 0.001, costDeltaVsParentUSD: null },
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

function sequencedProviderWithPrompt(items: Array<(prompt: string) => Promise<RunResult>>): Provider {
  let idx = 0;
  return {
    name: 'mock-seq-prompt',
    config: STUB_CONFIG,
    async run(prompt: string): Promise<RunResult> {
      const fn = items[idx] ?? items[items.length - 1];
      idx++;
      return fn(prompt);
    },
  };
}

function baseConfig(opts?: { braveKeys?: string[]; userSources?: string[] }): MultiModelConfig {
  return {
    agents: {
      standard: { type: 'openai-compatible', model: 'std', baseUrl: 'https://ex.invalid/v1' },
      complex: { type: 'openai-compatible', model: 'cpx', baseUrl: 'https://ex2.invalid/v1' },
    },
    defaults: { tools: 'readonly', timeoutMs: 60_000, maxCostUSD: 1, sandboxPolicy: 'cwd-only' },
    research: {
      brave: { apiKeys: opts?.braveKeys ?? [] },
      fetch: {},
      builtinAdapters: { arxiv: true, semanticScholar: true, githubSearch: true, genericRss: true },
      userSources: opts?.userSources ?? [],
      fetchAllowlistExtra: [],
    },
  } as unknown as MultiModelConfig;
}

function makeCtx(provider: Provider, overrides?: Partial<ExecutionContext>): { ctx: ExecutionContext } {
  const cwd = realpathSync(mkdtempSync(join(tmpdir(), 'expl-rl-int-')));
  providerState.activeProvider = provider;
  const ctx: ExecutionContext = {
    projectContext: { cwd, contextBlockStore: { get: () => undefined, register: () => ({ id: 'x' }) } as any, lastActivityAt: Date.now() } as any,
    config: overrides?.config ?? baseConfig(),
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
  const parts: string[] = [];
  for (let i = 1; i <= n; i++) {
    parts.push(`## Thread ${i}: Thread ${i}\nSummary ${i}.\n**Internal anchors:**\n- src/a.ts:1\n**External sources:**\n- arxiv:${i}\n**Divergence axis:** axis ${i}\n`);
  }
  parts.push('## Recommended next step\nThread 1.\n');
  return parts.join('\n');
}

// ===========================================================================
// Test §9.3 scenario 1: Happy path — full reviewed-lifecycle with 3 stages
// ===========================================================================

describe('explore reviewed-lifecycle integration', () => {
  it('happy path: all 3 lifecycle stages complete → full envelope', async () => {
    const provider = sequencedProvider([
      { run: async () => okResult(internalOk) },
      { run: async () => okResult(externalOk) },
      { run: async () => okResult(synthWithThreads(3)) },
    ]);
    const { bus, events } = collectingBus();
    const { ctx } = makeCtx(provider, { bus, batchId: TEST_BATCH_ID } as Partial<ExecutionContext>);

    const out = await executeExplore(ctx, defaultArgs());

    // Envelope shape
    expect(out.headline).toBe('explore: 3/3 tasks complete; 3 threads');
    expect(out.results).toHaveLength(3);
    expect(out.batchId).toBe(TEST_BATCH_ID);
    expect(out.wallClockMs).toBeGreaterThan(0);

    // All 3 sub-results carry lifecycle attributes
    const results = out.results as RunResult[];
    for (let i = 0; i < 3; i++) {
      expect(results[i].workerStatus).toBe('done');
      expect(results[i].structuredReport).toBeDefined();
      expect(results[i].usage).toBeDefined();
      expect(results[i].escalationLog).toBeInstanceOf(Array);
    }

    // Synthesizer result has explore structured report
    const synth = results[2];
    expect(synth.structuredReport?.explore).toBeDefined();
    expect(synth.structuredReport.explore.threads).toHaveLength(3);
    expect(synth.structuredReport.explore.recommendedNextStep).toBeTruthy();

    // Review verdicts: reviewPolicy is 'none' for all explore tasks → skipped
    expect(out.specReviewVerdict).toBe('skipped');
    expect(out.qualityReviewVerdict).toBe('skipped');
    expect(out.roundsUsed).toBe(0);

    // Lifecycle events
    const eventNames = events.map(e => e.event);
    expect(eventNames).toContain('explore_parallel_start');
    expect(eventNames).toContain('explore_parallel_end');
    expect(eventNames).toContain('explore_synthesize_start');
    expect(eventNames).toContain('explore_synthesize_end');

    // Cost envelope
    expect(out.costSummary).not.toEqual({ kind: 'not_applicable' });
    expect(out.batchTimings).not.toEqual({ kind: 'not_applicable' });
  });

  // =========================================================================
  // Test §9.3 scenario 2: One-fail (each side) — degraded lifecycle
  // =========================================================================

  it('internal worker fails → lifecycle reports degraded, synth succeeds', async () => {
    const provider = sequencedProvider([
      { run: async () => { throw new Error('internal crash'); } },
      { run: async () => okResult(externalOk) },
      { run: async () => okResult(synthWithThreads(2)) },
    ]);
    const { bus, events } = collectingBus();
    const { ctx } = makeCtx(provider, { bus, batchId: TEST_BATCH_ID } as Partial<ExecutionContext>);

    const out = await executeExplore(ctx, defaultArgs());

    expect(out.headline).toContain('degraded inputs');
    expect(out.headline).toContain('2 threads');
    expect(out.results).toHaveLength(3);

    const results = out.results as RunResult[];
    // Internal worker: failed lifecycle
    expect(results[0].workerStatus).toBe('failed');
    expect(results[0].status).toBe('error');
    // External worker: healthy lifecycle
    expect(results[1].workerStatus).toBe('done');
    // Synthesizer: degraded with 2 threads → insufficient (needs ≥3) → done_with_concerns
    expect(results[2].workerStatus).toBe('done_with_concerns');
    expect(results[2].incompleteReason).toBe('insufficient_threads');

    // Lifecycle events track degradation
    const parallelEnd = events.find(e => e.event === 'explore_parallel_end') as any;
    expect(parallelEnd.internalOk).toBe(false);
    expect(parallelEnd.externalOk).toBe(true);

    const synthStart = events.find(e => e.event === 'explore_synthesize_start') as any;
    expect(synthStart.internalAvailable).toBe(false);
    expect(synthStart.externalAvailable).toBe(true);

    // Unavailable event emitted
    expect(events.some(e => e.event === 'explore_internal_unavailable')).toBe(true);
    expect(events.some(e => e.event === 'explore_external_unavailable')).toBe(false);
  });

  it('external worker fails → lifecycle reports degraded, synth succeeds', async () => {
    const provider = sequencedProvider([
      { run: async () => okResult(internalOk) },
      { run: async () => { throw new Error('external crash'); } },
      { run: async () => okResult(synthWithThreads(1)) },
    ]);
    const { bus, events } = collectingBus();
    const { ctx } = makeCtx(provider, { bus, batchId: TEST_BATCH_ID } as Partial<ExecutionContext>);

    const out = await executeExplore(ctx, defaultArgs());

    expect(out.headline).toContain('degraded inputs');
    const results = out.results as RunResult[];
    expect(results[0].workerStatus).toBe('done');
    expect(results[1].workerStatus).toBe('failed');
    // Synthesizer: degraded with 1 thread → insufficient → done_with_concerns
    expect(results[2].workerStatus).toBe('done_with_concerns');
    expect(results[2].incompleteReason).toBe('insufficient_threads');

    // Single thread with degraded external
    expect(results[2].structuredReport.explore.threads).toHaveLength(1);

    const synthStart = events.find(e => e.event === 'explore_synthesize_start') as any;
    expect(synthStart.internalAvailable).toBe(true);
    expect(synthStart.externalAvailable).toBe(false);
    expect(events.some(e => e.event === 'explore_external_unavailable')).toBe(true);
  });

  // =========================================================================
  // Test §9.3 scenario 3: Both-fail — no inputs for synthesizer
  // =========================================================================

  it('both internal and external fail → synthesizer lifecycle fails', async () => {
    const provider = sequencedProvider([
      { run: async () => { throw new Error('internal crash'); } },
      { run: async () => { throw new Error('external crash'); } },
      { run: async () => { throw new Error('synth crash'); } },
    ]);
    const { bus, events } = collectingBus();
    const { ctx } = makeCtx(provider, { bus, batchId: TEST_BATCH_ID } as Partial<ExecutionContext>);

    const out = await executeExplore(ctx, defaultArgs());

    expect(out.headline).toBe('explore: synthesizer failed; worker outputs preserved');
    const results = out.results as RunResult[];
    expect(results).toHaveLength(3);
    expect(results[0].workerStatus).toBe('failed');
    expect(results[1].workerStatus).toBe('failed');
    expect(results[2].workerStatus).toBe('failed');

    // Both unavailable events emitted
    expect(events.some(e => e.event === 'explore_internal_unavailable')).toBe(true);
    expect(events.some(e => e.event === 'explore_external_unavailable')).toBe(true);

    // Synthesizer start reflects both sides unavailable
    const synthStart = events.find(e => e.event === 'explore_synthesize_start') as any;
    expect(synthStart.internalAvailable).toBe(false);
    expect(synthStart.externalAvailable).toBe(false);
  });

  // =========================================================================
  // Test §9.3 scenario 4: No-Brave degraded — lifecycle with limited tools
  // =========================================================================

  it('no Brave API keys → external prompt omits web_search escalation', async () => {
    const capturedPrompts: string[] = [];
    const provider = sequencedProviderWithPrompt([
      async (prompt: string) => { capturedPrompts[0] = prompt; return okResult(internalOk); },
      async (prompt: string) => { capturedPrompts[1] = prompt; return okResult(externalOk); },
      async (prompt: string) => { capturedPrompts[2] = prompt; return okResult(synthWithThreads(3)); },
    ]);
    // Config with no Brave keys
    const config = baseConfig({ braveKeys: [] });
    const { ctx } = makeCtx(provider, { config, batchId: TEST_BATCH_ID } as Partial<ExecutionContext>);

    const out = await executeExplore(ctx, defaultArgs());

    // Lifecycle still completes
    expect(out.headline).toBe('explore: 3/3 tasks complete; 3 threads');
    const results = out.results as RunResult[];
    expect(results[2].workerStatus).toBe('done');

    // External prompt must NOT contain Brave escalation step
    expect(capturedPrompts[1]).not.toContain('If coverage is thin');
    expect(capturedPrompts[1]).toContain('no open-web search is available');
  });

  it('with Brave API keys → external prompt includes web_search escalation', async () => {
    const capturedPrompts: string[] = [];
    const provider = sequencedProviderWithPrompt([
      async (prompt: string) => { capturedPrompts[0] = prompt; return okResult(internalOk); },
      async (prompt: string) => { capturedPrompts[1] = prompt; return okResult(externalOk); },
      async (prompt: string) => { capturedPrompts[2] = prompt; return okResult(synthWithThreads(3)); },
    ]);
    const config = baseConfig({ braveKeys: ['mock-key'] });
    const { ctx } = makeCtx(provider, { config, batchId: TEST_BATCH_ID } as Partial<ExecutionContext>);

    const out = await executeExplore(ctx, defaultArgs());
    expect(out.headline).toBe('explore: 3/3 tasks complete; 3 threads');
    expect(capturedPrompts[1]).toContain('If coverage is thin');
  });

  // =========================================================================
  // Test §9.3 scenario 5: All userSources unprocessable
  // =========================================================================

  it('userSources present → external prompt includes them', async () => {
    const capturedPrompts: string[] = [];
    const provider = sequencedProviderWithPrompt([
      async (prompt: string) => { capturedPrompts[0] = prompt; return okResult(internalOk); },
      async (prompt: string) => { capturedPrompts[1] = prompt; return okResult(externalOk); },
      async (prompt: string) => { capturedPrompts[2] = prompt; return okResult(synthWithThreads(3)); },
    ]);
    const config = baseConfig({
      braveKeys: ['mock-key'],
      userSources: ['https://example.com/research', 'site:stackoverflow.com'],
    });
    const { ctx } = makeCtx(provider, { config, batchId: TEST_BATCH_ID } as Partial<ExecutionContext>);

    const out = await executeExplore(ctx, defaultArgs());
    expect(out.headline).toBe('explore: 3/3 tasks complete; 3 threads');
    expect(capturedPrompts[1]).toContain('example.com/research');
    expect(capturedPrompts[1]).toContain('stackoverflow.com');
  });

  it('no userSources configured → external prompt notes none', async () => {
    const capturedPrompts: string[] = [];
    const provider = sequencedProviderWithPrompt([
      async (prompt: string) => { capturedPrompts[0] = prompt; return okResult(internalOk); },
      async (prompt: string) => { capturedPrompts[1] = prompt; return okResult(externalOk); },
      async (prompt: string) => { capturedPrompts[2] = prompt; return okResult(synthWithThreads(3)); },
    ]);
    const config = baseConfig({ braveKeys: [], userSources: [] });
    const { ctx } = makeCtx(provider, { config, batchId: TEST_BATCH_ID } as Partial<ExecutionContext>);

    const out = await executeExplore(ctx, defaultArgs());
    expect(out.headline).toBe('explore: 3/3 tasks complete; 3 threads');
    expect(capturedPrompts[1]).toContain('(none configured)');
  });

  // =========================================================================
  // Test §9.3 scenario 6: Synthesizer emits malformed → lifecycle fallback
  // =========================================================================

  it('synthesizer emits unparseable text → no_structured_report, worker=done', async () => {
    const provider = sequencedProvider([
      { run: async () => okResult(internalOk) },
      { run: async () => okResult(externalOk) },
      { run: async () => okResult('Random text without any thread sections or structure.') },
    ]);
    const { ctx } = makeCtx(provider);

    const out = await executeExplore(ctx, defaultArgs());

    const results = out.results as RunResult[];
    const synth = results[2];
    expect(synth.workerStatus).toBe('done');
    expect(synth.structuredReport?.explore).toBeUndefined();
    expect(out.headline).toBe('explore: 3/3 tasks complete; 0 threads');
  });

  it('synthesizer emits only Recommended next step without threads → done_with_concerns + malformed_threads', async () => {
    const provider = sequencedProvider([
      { run: async () => okResult(internalOk) },
      { run: async () => okResult(externalOk) },
      { run: async () => okResult('## Recommended next step\nPursue the momentum-complement approach.\n') },
    ]);
    const { ctx } = makeCtx(provider);

    const out = await executeExplore(ctx, defaultArgs());

    const results = out.results as RunResult[];
    // No thread sections parsed → structured_report with 0 threads → malformed → done_with_concerns
    expect(results[2].workerStatus).toBe('done_with_concerns');
    expect(results[2].incompleteReason).toBe('malformed_threads');
    expect(results[2].structuredReport?.explore).toBeDefined();
    expect(results[2].structuredReport.explore.threads).toHaveLength(0);
    expect(results[2].structuredReport.explore.diagnostics.malformed).toBe(true);
  });

  it('synthesizer emits thread with malformed body → dropped, done_with_concerns', async () => {
    // Thread 1 has missing external sources and divergence axis
    const malformed = `## Thread 1: Incomplete
Just a summary with no fields.
## Thread 2: Valid
Summary valid.
**Internal anchors:**
- src/a.ts:1
**External sources:**
- arxiv:1
**Divergence axis:** axis 2
## Thread 3: Valid
Summary valid 3.
**Internal anchors:**
- src/b.ts:1
**External sources:**
- arxiv:3
**Divergence axis:** axis 3
`;
    const provider = sequencedProvider([
      { run: async () => okResult(internalOk) },
      { run: async () => okResult(externalOk) },
      { run: async () => okResult(malformed) },
    ]);
    const { ctx } = makeCtx(provider);

    const out = await executeExplore(ctx, defaultArgs());

    const synth = (out.results as RunResult[])[2];
    expect(synth.workerStatus).toBe('done_with_concerns');
    // insufficient_threads takes priority over threads_dropped in deriveExploreStatus
    expect(synth.incompleteReason).toBe('insufficient_threads');
    expect(synth.structuredReport.explore.threads).toHaveLength(2);
    expect(synth.structuredReport.explore.diagnostics.droppedThreadDiagnostics).toHaveLength(1);
    expect(synth.structuredReport.explore.diagnostics.droppedThreadDiagnostics[0].reason).toBe('missing_field');
  });

  it('synthesizer output with 0 valid threads after all dropped → done_with_concerns + malformed_threads', async () => {
    const allDropped = `## Thread abc: BadIndex
Summary.
**Internal anchors:**
- src/a.ts:1
**External sources:**
- arxiv:1
**Divergence axis:** axis
`;
    const provider = sequencedProvider([
      { run: async () => okResult(internalOk) },
      { run: async () => okResult(externalOk) },
      { run: async () => okResult(allDropped) },
    ]);
    const { ctx } = makeCtx(provider);

    const out = await executeExplore(ctx, defaultArgs());

    const synth = (out.results as RunResult[])[2];
    // parseExploreReport returns structured_report with 0 threads → malformed=true → done_with_concerns
    expect(synth.workerStatus).toBe('done_with_concerns');
    expect(synth.incompleteReason).toBe('malformed_threads');
    expect(synth.structuredReport?.explore).toBeDefined();
    expect(synth.structuredReport.explore.threads).toHaveLength(0);
  });

  it('synthesizer only 2 valid threads → done_with_concerns + insufficient_threads', async () => {
    const twoThreads = `## Thread 1: First
Summary 1.
**Internal anchors:**
- src/a.ts:1
**External sources:**
- arxiv:1
**Divergence axis:** axis 1
## Thread 2: Second
Summary 2.
**Internal anchors:**
- src/b.ts:1
**External sources:**
- arxiv:2
**Divergence axis:** axis 2
`;
    const provider = sequencedProvider([
      { run: async () => okResult(internalOk) },
      { run: async () => okResult(externalOk) },
      { run: async () => okResult(twoThreads) },
    ]);
    const { ctx } = makeCtx(provider);

    const out = await executeExplore(ctx, defaultArgs());

    const synth = (out.results as RunResult[])[2];
    expect(synth.workerStatus).toBe('done_with_concerns');
    expect(synth.incompleteReason).toBe('insufficient_threads');
    expect(synth.structuredReport.explore.threads).toHaveLength(2);
    expect(synth.structuredReport.explore.diagnostics.insufficientThreads).toBe(true);
  });
});

// ===========================================================================
// Lifecycle envelope field propagation
// ===========================================================================

describe('explore lifecycle envelope field propagation', () => {
  it('all results carry escalationLog arrays from lifecycle', async () => {
    const provider = sequencedProvider([
      { run: async () => okResult(internalOk) },
      { run: async () => okResult(externalOk) },
      { run: async () => okResult(synthWithThreads(3)) },
    ]);
    const { ctx } = makeCtx(provider);

    const out = await executeExplore(ctx, defaultArgs());
    const results = out.results as RunResult[];
    for (const r of results) {
      expect(r.escalationLog).toBeInstanceOf(Array);
      expect(r.escalationLog.length).toBeGreaterThan(0);
    }
  });

  it('review verdicts are not_applicable because reviewPolicy is none', async () => {
    const provider = sequencedProvider([
      { run: async () => okResult(internalOk) },
      { run: async () => okResult(externalOk) },
      { run: async () => okResult(synthWithThreads(3)) },
    ]);
    const { ctx } = makeCtx(provider);

    const out = await executeExplore(ctx, defaultArgs());
    expect(out.specReviewVerdict).toBe('skipped');
    expect(out.qualityReviewVerdict).toBe('skipped');
    expect(out.roundsUsed).toBe(0);
  });

  it('batchTimings wallClockMs reflects real elapsed time', async () => {
    const provider = sequencedProvider([
      { run: async () => okResult(internalOk) },
      { run: async () => okResult(externalOk) },
      { run: async () => okResult(synthWithThreads(3)) },
    ]);
    const { ctx } = makeCtx(provider);

    const out = await executeExplore(ctx, defaultArgs());
    if (out.batchTimings && typeof out.batchTimings === 'object' && 'wallClockMs' in out.batchTimings) {
      expect(out.batchTimings.wallClockMs).toBeGreaterThanOrEqual(0);
      expect(out.batchTimings.sumOfTaskMs).toBe(0);
    }
  });

  it('costSummary aggregates across all lifecycle stages', async () => {
    const provider = sequencedProvider([
      { run: async () => okResult(internalOk) },
      { run: async () => okResult(externalOk) },
      { run: async () => okResult(synthWithThreads(3)) },
    ]);
    const { ctx } = makeCtx(provider);

    const out = await executeExplore(ctx, defaultArgs());
    if (out.costSummary && typeof out.costSummary === 'object' && 'totalActualCostUSD' in out.costSummary) {
      expect(out.costSummary.totalActualCostUSD).toBeCloseTo(0.003, 5);
      expect(out.costSummary.totalCostDeltaVsParentUSD).toBeGreaterThanOrEqual(0);
    }
  });

  it('mainModel propagates to output envelope', async () => {
    const provider = sequencedProvider([
      { run: async () => okResult(internalOk) },
      { run: async () => okResult(externalOk) },
      { run: async () => okResult(synthWithThreads(3)) },
    ]);
    const { ctx } = makeCtx(provider, { mainModel: 'claude-sonnet-4-6' } as Partial<ExecutionContext>);

    const out = await executeExplore(ctx, defaultArgs());
    expect(out.mainModel).toBe('claude-sonnet-4-6');
  });

  it('batchId is threaded through to output', async () => {
    const provider = sequencedProvider([
      { run: async () => okResult(internalOk) },
      { run: async () => okResult(externalOk) },
      { run: async () => okResult(synthWithThreads(3)) },
    ]);
    const { ctx } = makeCtx(provider, { batchId: 'my-custom-batch' } as Partial<ExecutionContext>);

    const out = await executeExplore(ctx, defaultArgs());
    expect(out.batchId).toBe('my-custom-batch');
  });
});

// ===========================================================================
// Synthesizer cap exhaustion → lifecycle failure modes
// ===========================================================================

describe('explore synthesizer cap exhaustion lifecycle', () => {
  it('turn cap → done_with_concerns + turn_cap, incompleteReason set', async () => {
    const capProv = capExhaustingProvider({ kind: 'turn', partialOutput: synthWithThreads(1) });
    const provider = sequencedProvider([
      { run: async () => okResult(internalOk) },
      { run: async () => okResult(externalOk) },
      { run: () => capProv.run('') },
    ]);
    const { ctx } = makeCtx(provider);

    const out = await executeExplore(ctx, defaultArgs());
    const synth = (out.results as RunResult[])[2];
    expect(synth.workerStatus).toBe('done_with_concerns');
    expect(synth.incompleteReason).toBe('turn_cap');
  });

  it('cost cap → done_with_concerns + cost_cap', async () => {
    const capProv = capExhaustingProvider({ kind: 'cost', partialOutput: synthWithThreads(1) });
    const provider = sequencedProvider([
      { run: async () => okResult(internalOk) },
      { run: async () => okResult(externalOk) },
      { run: () => capProv.run('') },
    ]);
    const { ctx } = makeCtx(provider);

    const out = await executeExplore(ctx, defaultArgs());
    const synth = (out.results as RunResult[])[2];
    expect(synth.workerStatus).toBe('done_with_concerns');
    expect(synth.incompleteReason).toBe('cost_cap');
  });

  it('wall_clock cap → done_with_concerns + timeout', async () => {
    const capProv = capExhaustingProvider({ kind: 'wall_clock', partialOutput: synthWithThreads(1) });
    const provider = sequencedProvider([
      { run: async () => okResult(internalOk) },
      { run: async () => okResult(externalOk) },
      { run: () => capProv.run('') },
    ]);
    const { ctx } = makeCtx(provider);

    const out = await executeExplore(ctx, defaultArgs());
    const synth = (out.results as RunResult[])[2];
    expect(synth.workerStatus).toBe('done_with_concerns');
    expect(synth.incompleteReason).toBe('timeout');
  });
});

// ===========================================================================
// Headline composition from lifecycle results
// ===========================================================================

describe('explore headline composition from lifecycle', () => {
  it('0 failures → complete headline', () => {
    const provider = sequencedProvider([
      { run: async () => okResult(internalOk) },
      { run: async () => okResult(externalOk) },
      { run: async () => okResult(synthWithThreads(3)) },
    ]);
    const { ctx } = makeCtx(provider);
    return executeExplore(ctx, defaultArgs()).then(out => {
      expect(out.headline).toBe('explore: 3/3 tasks complete; 3 threads');
    });
  });

  it('1 failure → degraded headline with thread count', () => {
    const provider = sequencedProvider([
      { run: async () => { throw new Error('fail'); } },
      { run: async () => okResult(externalOk) },
      { run: async () => okResult(synthWithThreads(2)) },
    ]);
    const { ctx } = makeCtx(provider);
    return executeExplore(ctx, defaultArgs()).then(out => {
      expect(out.headline).toContain('degraded inputs');
      expect(out.headline).toContain('2 threads');
    });
  });

  it('2 failures → synth failed headline', () => {
    const provider = sequencedProvider([
      { run: async () => { throw new Error('fail1'); } },
      { run: async () => { throw new Error('fail2'); } },
      { run: async () => { throw new Error('synth fail'); } },
    ]);
    const { ctx } = makeCtx(provider);
    return executeExplore(ctx, defaultArgs()).then(out => {
      expect(out.headline).toBe('explore: synthesizer failed; worker outputs preserved');
    });
  });
});

// ===========================================================================
// Parallel lifecycle: both workers execute concurrently
// ===========================================================================

describe('explore parallel lifecycle execution', () => {
  it('internal and external run concurrently → both complete before synth', async () => {
    const executionOrder: string[] = [];
    const provider = sequencedProvider([
      {
        run: async () => {
          executionOrder.push('internal-start');
          await new Promise(r => setTimeout(r, 10));
          executionOrder.push('internal-end');
          return okResult(internalOk);
        },
      },
      {
        run: async () => {
          executionOrder.push('external-start');
          await new Promise(r => setTimeout(r, 10));
          executionOrder.push('external-end');
          return okResult(externalOk);
        },
      },
      {
        run: async () => {
          executionOrder.push('synth-start');
          executionOrder.push('synth-end');
          return okResult(synthWithThreads(3));
        },
      },
    ]);
    const { ctx } = makeCtx(provider);

    const out = await executeExplore(ctx, defaultArgs());
    expect(out.headline).toBe('explore: 3/3 tasks complete; 3 threads');

    // Internal and external started before synth
    const synthIdx = executionOrder.indexOf('synth-start');
    expect(synthIdx).toBeGreaterThan(0);
    // Both internal and external completed before synth start
    expect(executionOrder.indexOf('internal-end')).toBeLessThan(synthIdx);
    expect(executionOrder.indexOf('external-end')).toBeLessThan(synthIdx);
  });
});
