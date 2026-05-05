import { describe, it, expect, vi } from 'vitest';
import type { MultiModelConfig, TaskSpec, AgentType, Provider } from '../../packages/core/src/types.js';
import type { EventSink } from '../../packages/core/src/observability/bus.js';
import { EventBus } from '../../packages/core/src/observability/bus.js';
import type { InternalRunnerEvent } from '../../packages/core/src/runners/types.js';

vi.mock('fs/promises', () => ({
  readFile: vi.fn().mockResolvedValue('// mock file content\nconst x = 1;\n'),
}));

const IMPL_OUTPUT = [
  '# Audit Report',
  '### 1. Silent error swallowing in parseConfig',
  'Severity: high',
  'Location: src/a.ts:10',
  'The function silently swallows errors and returns null.',
].join('\n');

const REVIEWER_OUTPUT = [
  '```json',
  JSON.stringify([{
    id: 'F1', severity: 'high',
    claim: 'silent error swallowing in parseConfig',
    evidence: 'The function silently swallows errors and returns null.',
    annotatorConfidence: 80,
  }]),
  '```',
].join('\n');

/**
 * Mutable mode flag so individual tests can opt into the regression scenario
 * (implementer cost higher than reviewer cost) even though vi.mock is hoisted
 * and the factory is created once.
 */
let _mockMode: 'monotonic' | 'regression' = 'monotonic';

function makeMockCreateProvider() {
  return (slot: string) => ({
    name: slot,
    config: {
      type: 'openai-compatible' as const,
      model: `${slot}-model`,
      baseUrl: 'https://ex.invalid/v1',
      inputCostPerMTok: 3.0,
      outputCostPerMTok: 15.0,
    },
    run: async (_prompt: string, options?: { onProgress?: (e: InternalRunnerEvent) => void }) => {
      const onProgress = options?.onProgress;
      const isReviewer = slot === 'complex';
      // regression mode: implementer cost HIGHER than reviewer — the pre-fix
      // failure mode where heartbeat cost drops and quality review delta
      // becomes negative (see §3.9).
      const tokens = _mockMode === 'regression'
        ? isReviewer
          ? { inputTokens: 1000, outputTokens: 500, costUSD: 0.0105 }
          : { inputTokens: 40000, outputTokens: 10000, costUSD: 0.27 }
        : isReviewer
          ? { inputTokens: 40000, outputTokens: 10000, costUSD: 0.27 }
          : { inputTokens: 10000, outputTokens: 5000, costUSD: 0.105 };
      if (onProgress) {
        onProgress({
          kind: 'turn_complete' as const,
          turn: 1,
          cumulativeInputTokens: tokens.inputTokens,
          cumulativeOutputTokens: tokens.outputTokens,
        });
      }
      return {
        output: isReviewer ? REVIEWER_OUTPUT : IMPL_OUTPUT,
        status: 'ok' as const,
        usage: { inputTokens: tokens.inputTokens, outputTokens: tokens.outputTokens, cachedReadTokens: 0, cachedNonReadTokens: 0 },
        cost: { costUSD: tokens.costUSD, costDeltaVsParentUSD: null },
        turns: 1,
        filesRead: ['src/a.ts'],
        filesWritten: ['report.md'],
        toolCalls: ['readFile(src/a.ts)', 'writeFile(report.md)'],
        outputIsDiagnostic: false,
        escalationLog: [],
      };
    },
  });
}

vi.mock('@zhixuan92/multi-model-agent-core/provider', () => ({
  createProvider: makeMockCreateProvider(),
}));

function makeConfig(): MultiModelConfig {
  return {
    agents: {
      standard: {
        type: 'openai-compatible' as const,
        model: 'gpt-5',
        baseUrl: 'http://mock.local',
        apiKey: 'mock',
        inputCostPerMTok: 3.0,
        outputCostPerMTok: 15.0,
      },
      complex: {
        type: 'openai-compatible' as const,
        model: 'gpt-5.2',
        baseUrl: 'http://mock.local',
        apiKey: 'mock',
        inputCostPerMTok: 5.0,
        outputCostPerMTok: 25.0,
      },
    },
    defaults: {
      timeoutMs: 300_000,
      stallTimeoutMs: 600_000,
      maxCostUSD: 10,
      tools: 'full' as const,
      sandboxPolicy: 'cwd-only' as const,
    },
    server: {
      bind: '127.0.0.1',
      port: 7337,
      auth: { tokenFile: '/tmp/mock-token' },
      limits: {
        maxBodyBytes: 1_000_000,
        batchTtlMs: 300_000,
        idleProjectTimeoutMs: 3_600_000,
        clarificationTimeoutMs: 300_000,
        projectCap: 10,
        maxBatchCacheSize: 10,
        maxContextBlockBytes: 100_000,
        maxContextBlocksPerProject: 10,
        shutdownDrainMs: 5_000,
      },
      autoUpdateSkills: false,
    },
  };
}

/**
 * Run the reviewed lifecycle and capture all bus events. Returns the result
 * and the captured events for assertion.
 */
async function runReviewedLifecycleAndCaptureEvents(opts?: {
  recordHeartbeat?: boolean;
}) {
  const { executeReviewedLifecycle } = await import('../../packages/core/src/run-tasks/reviewed-lifecycle.js');
  const { createProvider } = await import('@zhixuan92/multi-model-agent-core/provider');

  const config = makeConfig();
  const task: TaskSpec = {
    prompt: 'audit this code',
    agentType: 'complex' as const,
    reviewPolicy: 'quality_only' as const,
  };

  const implProvider = (createProvider as any)('standard') as Provider;
  const resolved: { slot: AgentType; provider: Provider } = {
    slot: 'standard',
    provider: implProvider,

  };

  const events: unknown[] = [];
  const sink: EventSink = { name: 'capture', emit: event => { events.push(event); } };
  const bus = new EventBus([sink]);

  const builder = (ctx: { workerOutput: string; brief: string }) =>
    `Annotation prompt\n\n${ctx.workerOutput}\n\nannotatorConfidence: score each finding 0-100`;

  const heartbeatCfg = {
    batchId: '00000000-0000-4000-8000-000000000000',
    ...(opts?.recordHeartbeat ? { recordHeartbeat: () => {} } : {}),
  };

  const result = await executeReviewedLifecycle(
    task, resolved, config, 0,
    undefined,
    heartbeatCfg,
    undefined, undefined, 'audit',
    undefined, undefined,
    bus,
    builder,
  );

  return { result, events };
}

/**
 * Extract cost from a heartbeat event envelope. Returns the numeric cost or null.
 */
function extractHeartbeatCost(e: unknown): number | null {
  const ev = e as { event?: string; cost?: number | null };
  if (ev.event !== 'heartbeat') return null;
  return ev.cost ?? null;
}

describe('review-cost-monotonic (§3.9)', () => {
  beforeEach(() => {
    _mockMode = 'monotonic';
  });

  it('runningCostUSD is monotone non-decreasing across stage transitions (heartbeat events carry cumulative cost)', async () => {
    const { events } = await runReviewedLifecycleAndCaptureEvents({ recordHeartbeat: true });

    // §3.9 invariant: heartbeat event cost must be monotone non-decreasing.
    // With the cumulative-cost fix, the heartbeat timer's costUSD reflects
    // completed-runners-total + current-runner-partial, so it cannot drop.
    let lastCost = 0;
    let samples = 0;
    for (const e of events) {
      const cost = extractHeartbeatCost(e);
      if (cost !== null) {
        samples++;
        expect(cost).toBeGreaterThanOrEqual(lastCost);
        lastCost = cost;
      }
    }
    // Verify we observed at least one heartbeat emission with a cost value.
    expect(samples).toBeGreaterThanOrEqual(1);
  });

  it('read_only_review.quality.costUSD equals reviewer actual usage when reviewer cost exceeds implementer', async () => {
    const { events, result } = await runReviewedLifecycleAndCaptureEvents();

    const reviewEvent = events.find(e => (e as { event?: string }).event === 'read_only_review.quality');
    expect(reviewEvent).toBeDefined();
    const cost = (reviewEvent as { costUSD?: number | null }).costUSD;
    expect(cost).not.toBeNull();
    expect(cost).toBeGreaterThanOrEqual(0);
    expect(cost!).toBeCloseTo(0.27, 10);
    expect(result.stageStats!.quality_review.costUSD!).toBeCloseTo(0.27, 10);
    expect(result.stageStats!.implementing.costUSD!).toBeCloseTo(0.105, 10);
  });

  it('read_only_review.quality event passes Zod schema validation (costUSD >= 0 enforced by .min(0))', async () => {
    const { events } = await runReviewedLifecycleAndCaptureEvents();
    const { ReadOnlyReviewQualityEvent } = await import('../../packages/core/src/observability/events.js');

    const reviewEvent = events.find(e => (e as { event?: string }).event === 'read_only_review.quality');
    expect(reviewEvent).toBeDefined();
    const parseResult = ReadOnlyReviewQualityEvent.safeParse(reviewEvent);
    if (!parseResult.success) {
      console.error('Zod parse failure:', JSON.stringify(parseResult.error.issues, null, 2));
    }
    expect(parseResult.success).toBe(true);
  });

  it('stageStats costUSD >= 0 for every entered stage', async () => {
    const { result } = await runReviewedLifecycleAndCaptureEvents({ recordHeartbeat: true });

    expect(result.stageStats).toBeDefined();
    const stats = result.stageStats!;
    const stageNames = ['implementing', 'spec_review', 'spec_rework', 'quality_review', 'quality_rework', 'verifying', 'diff_review', 'committing'] as const;
    for (const name of stageNames) {
      const s = stats[name];
      if (s.entered && s.costUSD !== null) {
        expect(s.costUSD).toBeGreaterThanOrEqual(0);
      }
    }
  });

  describe('regression: implementer cost higher than reviewer cost', () => {
    beforeEach(() => {
      _mockMode = 'regression';
    });

    it('read_only_review.quality.costUSD equals reviewer actual usage when implementer cost exceeds reviewer', async () => {
      // This is the known failure mode from §3.9: the implementer processes
      // far more tokens than the reviewer. The review event must report the
      // reviewer stage cost itself, not reviewerCost - implementerCost.
      const { events, result } = await runReviewedLifecycleAndCaptureEvents();

      const reviewEvent = events.find(e => (e as { event?: string }).event === 'read_only_review.quality');
      expect(reviewEvent).toBeDefined();
      const cost = (reviewEvent as { costUSD?: number | null }).costUSD;
      expect(cost).not.toBeNull();
      expect(cost).toBeGreaterThanOrEqual(0);
      expect(cost!).toBeCloseTo(0.0105, 10);
      expect(result.stageStats!.quality_review.costUSD!).toBeCloseTo(0.0105, 10);
      expect(result.stageStats!.implementing.costUSD!).toBeCloseTo(0.27, 10);
    });

    it('heartbeat cost is monotonic when implementer cost exceeds reviewer cost', async () => {
      const { events } = await runReviewedLifecycleAndCaptureEvents({ recordHeartbeat: true });

      let lastCost = 0;
      let samples = 0;
      for (const e of events) {
        const cost = extractHeartbeatCost(e);
        if (cost !== null) {
          samples++;
          expect(cost).toBeGreaterThanOrEqual(lastCost);
          lastCost = cost;
        }
      }
      expect(samples).toBeGreaterThanOrEqual(1);
    });

    it('stageStats costUSD >= 0 for every entered stage in regression mode', async () => {
      const { result } = await runReviewedLifecycleAndCaptureEvents({ recordHeartbeat: true });

      expect(result.stageStats).toBeDefined();
      const stats = result.stageStats!;
      const stageNames = ['implementing', 'spec_review', 'spec_rework', 'quality_review', 'quality_rework', 'verifying', 'diff_review', 'committing'] as const;
      for (const name of stageNames) {
        const s = stats[name];
        if (s.entered && s.costUSD !== null) {
          expect(s.costUSD).toBeGreaterThanOrEqual(0);
        }
      }
    });

    it('cumulative heartbeat task cost equals sum of actual stage usage costs', async () => {
      const { events, result } = await runReviewedLifecycleAndCaptureEvents({ recordHeartbeat: true });

      expect(result.stageStats).toBeDefined();
      const stats = result.stageStats!;

      let stageSum = 0;
      const stageNames = ['implementing', 'spec_review', 'spec_rework', 'quality_review', 'quality_rework', 'verifying', 'diff_review', 'committing'] as const;
      for (const name of stageNames) {
        const s = stats[name];
        if (s.entered && s.costUSD !== null) stageSum += s.costUSD;
      }

      const terminal = events.find(e => (e as { event?: string }).event === 'read_only_review.terminal') as { costUSD?: number | null } | undefined;
      expect(terminal?.costUSD).not.toBeNull();
      expect(terminal!.costUSD!).toBeCloseTo(stageSum, 10);
      expect(stageSum).toBeCloseTo(0.2805, 10);
    });
  });
});
