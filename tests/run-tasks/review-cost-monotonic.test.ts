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
    reviewerConfidence: 80,
  }]),
  '```',
].join('\n');

/**
 * Provider factory with monotonic costs.
 *
 * The reviewer (slot === 'complex') reports higher cumulative token counts so
 * computeCostUSD(reviewerTokens, config) >= computeCostUSD(implTokens, config).
 * With the 3.0/15.0 per-MTok pricing on the resolved provider config:
 *   impl:   (10000/1e6)*3.0 + (5000/1e6)*15.0  = 0.105
 *   reviewer: (40000/1e6)*3.0 + (10000/1e6)*15.0 = 0.27
 * heartbeat cost is naturally monotonic (0.105 → 0.27).
 *
 * The runtime assertion in runningCostUSD() (throw in test/dev) still guards
 * against regressions that would make the raw cost drop.
 */
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
      // Reviewer reports higher cumulative token counts so the heartbeat cost
      // is monotone non-decreasing (§3.9 invariant).
      const tokens = isReviewer
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
        usage: { inputTokens: tokens.inputTokens, outputTokens: tokens.outputTokens, totalTokens: tokens.inputTokens + tokens.outputTokens, costUSD: tokens.costUSD },
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

// Top-level mock — executes BEFORE executeReviewedLifecycle is imported,
// so the module's createProvider import sees this mock.
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
 * Extract cost from a heartbeat event envelope. Returns the numeric cost or null
 * if the event isn't a heartbeat or cost is null.
 */
function extractRunningCost(e: unknown): number | null {
  const ev = e as { event?: string; cost?: number | null };
  if (ev.event !== 'heartbeat') return null;
  return ev.cost ?? null;
}

describe('review-cost-monotonic (§3.9)', () => {
  it('runningCostUSD is monotone non-decreasing across stage transitions (heartbeat events)', async () => {
    const { executeReviewedLifecycle } = await import('../../packages/core/src/run-tasks/reviewed-lifecycle.js');
    const { createProvider } = await import('@zhixuan92/multi-model-agent-core/provider');

    const config = makeConfig();
    const task: TaskSpec = {
      prompt: 'audit this code',
      agentType: 'complex' as const,
      reviewPolicy: 'quality_only' as const,
    };

    const implProvider = (createProvider as any)('standard') as Provider;
    const resolved: { slot: AgentType; provider: Provider; capabilityOverride: boolean } = {
      slot: 'standard',
      provider: implProvider,
      capabilityOverride: false,
    };

    const events: unknown[] = [];
    const sink: EventSink = { name: 'capture', emit: event => { events.push(event); } };
    const bus = new EventBus([sink]);

    const builder = (ctx: { workerOutput: string; brief: string }) =>
      `Annotation prompt\n\n${ctx.workerOutput}\n\nreviewerConfidence: score each finding 0-100`;

    await executeReviewedLifecycle(
      task, resolved, config, 0,
      undefined,
      { batchId: '00000000-0000-4000-8000-000000000000', recordHeartbeat: () => {} },
      undefined, undefined, 'audit',
      undefined, undefined,
      bus,
      builder,
    );

    // §3.9 invariant: every heartbeat event's cost is monotone non-decreasing.
    let lastCost = 0;
    for (const e of events) {
      const cost = extractRunningCost(e);
      if (cost !== null) {
        expect(cost).toBeGreaterThanOrEqual(lastCost);
        lastCost = cost;
      }
    }
  });

  it('read_only_review.quality.costUSD >= 0', async () => {
    const { executeReviewedLifecycle } = await import('../../packages/core/src/run-tasks/reviewed-lifecycle.js');
    const { createProvider } = await import('@zhixuan92/multi-model-agent-core/provider');

    const config = makeConfig();
    const task: TaskSpec = {
      prompt: 'audit this code',
      agentType: 'complex' as const,
      reviewPolicy: 'quality_only' as const,
    };

    const implProvider = (createProvider as any)('standard') as Provider;
    const resolved: { slot: AgentType; provider: Provider; capabilityOverride: boolean } = {
      slot: 'standard',
      provider: implProvider,
      capabilityOverride: false,
    };

    const events: unknown[] = [];
    const sink: EventSink = { name: 'capture', emit: event => { events.push(event); } };
    const bus = new EventBus([sink]);

    const builder = (ctx: { workerOutput: string; brief: string }) =>
      `Annotation prompt\n\n${ctx.workerOutput}\n\nreviewerConfidence: score each finding 0-100`;

    await executeReviewedLifecycle(
      task, resolved, config, 0,
      undefined,
      { batchId: '00000000-0000-4000-8000-000000000000' },
      undefined, undefined, 'audit',
      undefined, undefined,
      bus,
      builder,
    );

    const reviewEvent = events.find(e => (e as { event?: string }).event === 'read_only_review.quality');
    expect(reviewEvent).toBeDefined();
    const cost = (reviewEvent as { costUSD?: number | null }).costUSD;
    if (cost !== null) {
      expect(cost).toBeGreaterThanOrEqual(0);
    }
  });

  it('read_only_review.quality event passes Zod schema validation (costUSD >= 0 enforced by .min(0))', async () => {
    const { executeReviewedLifecycle } = await import('../../packages/core/src/run-tasks/reviewed-lifecycle.js');
    const { createProvider } = await import('@zhixuan92/multi-model-agent-core/provider');
    const { ReadOnlyReviewQualityEvent } = await import('../../packages/core/src/observability/events.js');

    const config = makeConfig();
    const task: TaskSpec = {
      prompt: 'audit this code',
      agentType: 'complex' as const,
      reviewPolicy: 'quality_only' as const,
    };

    const implProvider = (createProvider as any)('standard') as Provider;
    const resolved: { slot: AgentType; provider: Provider; capabilityOverride: boolean } = {
      slot: 'standard',
      provider: implProvider,
      capabilityOverride: false,
    };

    const events: unknown[] = [];
    const sink: EventSink = { name: 'capture', emit: event => { events.push(event); } };
    const bus = new EventBus([sink]);

    const builder = (ctx: { workerOutput: string; brief: string }) =>
      `Annotation prompt\n\n${ctx.workerOutput}\n\nreviewerConfidence: score each finding 0-100`;

    await executeReviewedLifecycle(
      task, resolved, config, 0,
      undefined,
      { batchId: '00000000-0000-4000-8000-000000000000' },
      undefined, undefined, 'audit',
      undefined, undefined,
      bus,
      builder,
    );

    const reviewEvent = events.find(e => (e as { event?: string }).event === 'read_only_review.quality');
    expect(reviewEvent).toBeDefined();
    const parseResult = ReadOnlyReviewQualityEvent.safeParse(reviewEvent);
    if (!parseResult.success) {
      console.error('Zod parse failure:', JSON.stringify(parseResult.error.issues, null, 2));
    }
    expect(parseResult.success).toBe(true);
  });

  it('read_only_review.quality.costUSD >= 0 in stageStats', async () => {
    const { executeReviewedLifecycle } = await import('../../packages/core/src/run-tasks/reviewed-lifecycle.js');
    const { createProvider } = await import('@zhixuan92/multi-model-agent-core/provider');

    const config = makeConfig();
    const task: TaskSpec = {
      prompt: 'audit this code',
      agentType: 'complex' as const,
      reviewPolicy: 'quality_only' as const,
    };

    const implProvider = (createProvider as any)('standard') as Provider;
    const resolved: { slot: AgentType; provider: Provider; capabilityOverride: boolean } = {
      slot: 'standard',
      provider: implProvider,
      capabilityOverride: false,
    };

    const builder = (ctx: { workerOutput: string; brief: string }) =>
      `Annotation prompt\n\n${ctx.workerOutput}\n\nreviewerConfidence: score each finding 0-100`;

    const result = await executeReviewedLifecycle(
      task, resolved, config, 0,
      undefined,
      { batchId: '00000000-0000-4000-8000-000000000000', recordHeartbeat: () => {} },
      undefined, undefined, 'audit',
      undefined, undefined,
      undefined,
      builder,
    );

    // Every entered stage's costUSD must be >= 0 (H3 invariant from §3.9).
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
});
