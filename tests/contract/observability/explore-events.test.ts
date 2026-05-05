import { describe, expect, it, vi } from 'vitest';
import type { ExecutionContext } from '../../../packages/core/src/lifecycle/executors/types.js';
import type { MultiModelConfig, Provider, RunResult } from '../../../packages/core/src/types.js';
import { EventBus } from '../../../packages/core/src/events/bus.js';
import type { EventSink, EventType } from '../../../packages/core/src/events/bus.js';

const providerState = vi.hoisted(() => ({ activeProvider: undefined as Provider | undefined }));

vi.mock('@zhixuan92/multi-model-agent-core/providers/provider-factory', () => ({
  createProvider: () => providerState.activeProvider,
}));

import { executeExplore, type ExploreExecutorInput } from '../../../packages/core/src/lifecycle/executors/explore.js';
import exploreEventsGolden from '../goldens/observability/explore-events.json' with { type: 'json' };

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

const FIXTURE_CWD = '/tmp/mma-explore-events-fixture';

function makeCtx(provider: Provider, overrides?: Partial<ExecutionContext>): { ctx: ExecutionContext } {
  providerState.activeProvider = provider;
  const ctx: ExecutionContext = {
    projectContext: { cwd: FIXTURE_CWD, contextBlockStore: { get: () => undefined, register: () => ({ id: 'x' }) } as any, lastActivityAt: Date.now() } as any,
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

function collectingBus(): { bus: EventBus; events: EventType[] } {
  const events: EventType[] = [];
  const sink: EventSink = {
    name: 'test-collector',
    emit: (e) => { events.push(e); },
  };
  return { bus: new EventBus([sink]), events };
}

const internalOk = '## Reusable components\n1. src/signal.ts:10 — signal base class\n## Baseline-defining anchors\n2. src/momentum.ts:45 — current momentum\n## Adjacent prior art\n3. src/mean-reversion.ts:88 — old MR experiment\n## Unresolved\n';
const externalOk = '## Findings\n1. arxiv:2401.12345 — vol-targeting improves momentum\n## Sources used\n| arxiv | 1q | 1r |\n';

function synthWithThreads(n: number): string {
  const parts = ['## Context recap\nRecap.\n'];
  for (let i = 1; i <= n; i++) {
    parts.push(`## Thread ${i}: Thread ${i}\nSummary ${i}.\n**Internal anchors:**\n- src/a.ts:1\n**External sources:**\n- arxiv:${i}\n**Divergence axis:** axis ${i}\n`);
  }
  parts.push('## Recommended next step\nThread 1.\n');
  return parts.join('\n');
}

const VOLATILE_NUMERIC_KEYS = new Set([
  // camelCase
  'durationMs', 'elapsed', 'idleMs', 'costUSD', 'inputTokens', 'outputTokens',
  'cachedReadTokens', 'cachedNonReadTokens', 'totalTokens', 'cost_used_usd', 'cost_cap_usd',
  'wallClockMs', 'internalDurationMs', 'externalDurationMs', 'thresholdMs',
  'timeoutMs', 'taskMaxIdleMs', 'maxIdleMs', 'totalIdleMs', 'activityEvents',
  'stage_idle_ms', 'round',
  // snake_case (verbose-line events)
  'duration_ms', 'cost_usd', 'input_tokens', 'output_tokens', 'turns',
  'files_written', 'idle_ms',
]);

const VOLATILE_STRING_KEYS = new Set([
  'message',  // task_done_summary message contains timing
]);

/**
 * Strip volatile fields so the golden is deterministic across runs.
 * Keeps: event name, route, booleans, enums, and stable string fields.
 * Strips: timestamps, UUIDs, timing/cost numerics, machine-specific paths.
 */
function stripVolatile(event: Record<string, unknown>): Record<string, unknown> {
  const cleaned: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(event)) {
    if (k === 'ts' || k === 'batchId' || k === 'taskIndex') continue;
    if (k === 'cwd') continue;
    if (VOLATILE_NUMERIC_KEYS.has(k)) continue;
    if (VOLATILE_STRING_KEYS.has(k)) continue;
    if (typeof v === 'string' && /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}/.test(v)) continue;
    cleaned[k] = v;
  }
  return cleaned;
}

describe('explore observability event contract', () => {
  it('happy path events match golden', { timeout: 30_000 }, async () => {
    const provider = sequencedProvider([
      { run: async () => okResult(internalOk) },
      { run: async () => okResult(externalOk) },
      { run: async () => okResult(synthWithThreads(3)) },
    ]);
    const { bus, events } = collectingBus();
    const { ctx } = makeCtx(provider, { bus, batchId: TEST_BATCH_ID } as Partial<ExecutionContext>);

    const out = await executeExplore(ctx, defaultArgs());
    expect(out.headline).toBe('explore: 3/3 tasks complete; 3 threads');

    const stripped = events.map(e => stripVolatile(e as unknown as Record<string, unknown>));

    // Snapshot the event count — prevents silent addition/removal of events.
    expect(stripped).toHaveLength(exploreEventsGolden.events.length);

    // Compare each event shape against the golden.
    for (let i = 0; i < stripped.length; i++) {
      const actual = stripped[i];
      const expected = exploreEventsGolden.events[i];
      expect(actual, `event at index ${i} (${actual.event}) shape mismatch`).toEqual(expected);
    }
  });

  it('golden covers explore-specific batch events: always-emitted 6 present; 2 unavailable events are schema-declared but conditional', () => {
    const names = new Set(exploreEventsGolden.events.map((e: any) => e.event));
    // Always emitted in every explore batch.
    expect(names.has('explore_parallel_start'), 'explore_parallel_start missing').toBe(true);
    expect(names.has('explore_parallel_end'), 'explore_parallel_end missing').toBe(true);
    expect(names.has('explore_synthesize_start'), 'explore_synthesize_start missing').toBe(true);
    expect(names.has('explore_synthesize_end'), 'explore_synthesize_end missing').toBe(true);
    expect(names.has('explore_thread_started'), 'explore_thread_started missing').toBe(true);
    expect(names.has('explore_thread_completed'), 'explore_thread_completed missing').toBe(true);
    // explore_internal_unavailable and explore_external_unavailable are
    // schema-declared (events.ts) but only emitted when a worker degrades.
    // They are not in the happy-path golden; the explore executor tests in
    // tests/executors/explore.test.ts verify their emission on degradation.
  });
});
