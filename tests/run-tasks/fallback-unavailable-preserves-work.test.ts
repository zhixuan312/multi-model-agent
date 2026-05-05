import { describe, it, expect, vi } from 'vitest';
import { buildTaskCompletedEvent } from '../../packages/core/src/telemetry/event-builder.js';
import { ValidatedTaskCompletedEventSchema } from '../../packages/core/src/telemetry/types.js';
import { emptyStats, executeReviewedLifecycle } from '../../packages/core/src/run-tasks/reviewed-lifecycle.js';
import type { MultiModelConfig, TaskSpec, AgentType, Provider, RunResult } from '../../packages/core/src/types.js';

vi.mock('fs/promises', () => ({
  readFile: vi.fn().mockResolvedValue('// mock file content\nconst x = 1;\n'),
}));

vi.mock('@zhixuan92/multi-model-agent-core/provider', () => ({
  createProvider: (_slot: string) => ({
    name: 'escalation-mock',
    config: { type: 'openai-compatible' as const, model: 'gpt-5.2', baseUrl: 'https://ex.invalid/v1' },
    run: async () => ({
      output: '',
      status: 'timeout' as const,
      usage: { inputTokens: 0, outputTokens: 0, cachedReadTokens: 0, cachedNonReadTokens: 0 }, cost: { costUSD: 0, costDeltaVsParentUSD: null },
      turns: 0,
      filesRead: [],
      filesWritten: [],
      toolCalls: [],
      outputIsDiagnostic: true,
      escalationLog: [],
    }),
  }),
}));

// ── Config factory ───────────────────────────────────────────────────────

function makeConfig(): MultiModelConfig {
  return {
    agents: {
      standard: {
        type: 'openai-compatible',
        model: 'deepseek-v4-pro',
        baseUrl: 'http://mock.local',
        apiKey: 'mock',
      },
      complex: {
        type: 'openai-compatible',
        model: 'gpt-5.2',
        baseUrl: 'http://mock.local',
        apiKey: 'mock',
      },
    },
    defaults: {
      timeoutMs: 300_000,
      stallTimeoutMs: 600_000,
      maxCostUSD: 10,
      tools: 'full',
      sandboxPolicy: 'cwd-only',
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

// ── Test 12 Part B ───────────────────────────────────────────────────────
// Direct call to buildTaskCompletedEvent with a synthesized RunResult that
// simulates the shape produced by adaptForAllTiersUnavailable with a salvage
// source carrying 56 minutes of implementer work.

describe('Test 12 Part B — event-builder unit with salvage RunResult', () => {
  it('preserves implementerModel, duration, turns, filesWritten, cost, stages.length===1', () => {
    const runResult: RunResult = {
      output: 'real work done before both tiers became unavailable',
      status: 'incomplete',
      usage: { inputTokens: 47000, outputTokens: 12000, cachedReadTokens: 0, cachedNonReadTokens: 0 }, cost: { costUSD: 0.87, costDeltaVsParentUSD: null },
      turns: 42,
      filesRead: ['src/feature.ts', 'tests/feature.test.ts'],
      filesWritten: ['src/feature.ts', 'tests/feature.test.ts'],
      toolCalls: ['readFile(src/feature.ts)', 'writeFile(src/feature.ts)', 'readFile(tests/feature.test.ts)', 'writeFile(tests/feature.test.ts)'],
      outputIsDiagnostic: false,
      escalationLog: [
        { provider: 'standard', status: 'timeout' as const, turns: 42, inputTokens: 47000, outputTokens: 12000, costUSD: 0.87, initialPromptLengthChars: 5000, initialPromptHash: 'h1' },
      ],
      durationMs: 3_360_000,
      workerStatus: 'blocked',
      terminationReason: 'all_tiers_unavailable',
      stageStats: {
        ...emptyStats(),
        implementing: {
          stage: 'implementing',
          entered: true,
          durationMs: 3_360_000,
          costUSD: 0.87,
          agentTier: 'standard',
          modelFamily: 'deepseek',
          model: 'deepseek-v4-pro',
          maxIdleMs: 5000,
          totalIdleMs: 10000,
          activityEvents: 100,
          inputTokens: 47000,
          outputTokens: 12000,
          cachedReadTokens: 0, cachedNonReadTokens: 0,
          turnCount: 42,
          toolCallCount: 4,
          filesReadCount: 2,
          filesWrittenCount: 2,
        },
      },
      models: { implementer: 'deepseek-v4-pro', specReviewer: null, qualityReviewer: null },
      agents: {
        implementer: 'standard',
        implementerToolMode: 'full',
        specReviewer: 'not_applicable',
        qualityReviewer: 'not_applicable',
        fallbackOverrides: [
          {
            role: 'implementer' as const,
            loop: 'spec' as const,
            attempt: 0,
            assigned: 'standard' as const,
            used: 'none' as const,
            reason: 'transport_failure' as const,
            triggeringStatus: 'timeout' as const,
            bothUnavailable: true,
          },
        ],
      },
      concerns: [],
    };

    const event = buildTaskCompletedEvent({
      route: 'delegate',
      taskSpec: { filePaths: ['src/feature.ts'] },
      runResult,
      client: 'test-client',
      mainModel: null,
    });

    expect(event.terminalStatus).toBe('unavailable');
    expect(event.implementerModel).toBe('deepseek-v4-pro');
    expect(event.totalDurationMs).toBeGreaterThan(3_000_000);
    expect(event.stages).toHaveLength(1);

    const implStage = event.stages[0]!;
    expect(implStage.name).toBe('implementing');
    expect(implStage.turnCount).toBe(42);
    expect(implStage.filesWrittenCount).toBe(2);
    expect(implStage.costUSD).toBeCloseTo(0.87, 6);
    expect(implStage.inputTokens).toBe(47000);
    expect(implStage.outputTokens).toBe(12000);
  });
});

// ── Test 13 ──────────────────────────────────────────────────────────────
// R2.1: empty stages only allowed for brief_too_vague and error.
// 'unavailable' with empty stages MUST fail validation.

describe('Test 13 — R2.1 rejects empty stages for unavailable', () => {
  it('malformed unavailable + empty stages fails with R2.1 issue', () => {
    const malformed = {
      eventId: '00000000-0000-4000-8000-000000000000',
      route: 'delegate',
      client: 'test-client',
      agentType: 'standard',
      toolMode: 'full',
      reviewPolicy: 'full',
      verifyCommandPresent: false,
      implementerModel: 'custom',
      implementerTier: 'standard',
      terminalStatus: 'unavailable',
      workerStatus: 'blocked',
      errorCode: null,
      parentModel: null,
      parentModelFamily: 'other',
      tierUsage: {},
      inputTokens: 0,
      outputTokens: 0,
      cachedReadTokens: null,
      cachedNonReadTokens: null,
      totalDurationMs: 100,
      totalCostUSD: 0,
      parentEquivalentCostUSD: null,
      costDeltaVsParentUSD: null,
      concernCount: 0,
      escalationCount: 0,
      fallbackCount: 0,
      stallCount: 0,
      taskMaxIdleMs: 0,
      sandboxViolationCount: 0,
      stages: [] as any[],
    };

    const result = ValidatedTaskCompletedEventSchema.safeParse(malformed);
    expect(result.success).toBe(false);
    if (!result.success) {
      const issues = result.error.issues.map(i => i.message).join('\n');
      expect(issues).toContain('R2.1');
    }
  });

  it('unavailable with non-empty stages passes validation', () => {
    const valid = {
      eventId: '00000000-0000-4000-8000-000000000001',
      route: 'delegate',
      client: 'test-client',
      agentType: 'standard',
      toolMode: 'full',
      reviewPolicy: 'full',
      verifyCommandPresent: false,
      implementerModel: 'deepseek-v4-pro',
      implementerTier: 'standard',
      terminalStatus: 'unavailable',
      workerStatus: 'blocked',
      errorCode: null,
      parentModel: null,
      parentModelFamily: 'other',
      tierUsage: {},
      inputTokens: 5000,
      outputTokens: 2000,
      cachedReadTokens: null,
      cachedNonReadTokens: null,
      totalDurationMs: 3_360_000,
      totalCostUSD: 0.87,
      parentEquivalentCostUSD: null,
      costDeltaVsParentUSD: null,
      concernCount: 0,
      escalationCount: 0,
      fallbackCount: 1,
      stallCount: 0,
      taskMaxIdleMs: 0,
      sandboxViolationCount: 0,
      stages: [
        {
          name: 'implementing',
          model: 'deepseek-v4-pro',
          tier: 'standard',
          round: 0,
          durationMs: 3_360_000,
          costUSD: 0.87,
          inputTokens: 5000,
          outputTokens: 2000,
          cachedReadTokens: null,
          cachedNonReadTokens: null,
          toolCallCount: 4,
          filesReadCount: 2,
          filesWrittenCount: 2,
          turnCount: 42,
          maxIdleMs: 0,
          totalIdleMs: 0,
        },
      ],
    };

    const result = ValidatedTaskCompletedEventSchema.safeParse(valid);
    expect(result.success).toBe(true);
  });
});

// ── Test 14 ──────────────────────────────────────────────────────────────
// implementerModel lookup: models.implementer > stage model > 'custom'

describe('Test 14 — implementerModel lookup precedence', () => {
  function makeBaseRunResult(): RunResult {
    return {
      output: 'test',
      status: 'ok',
      usage: { inputTokens: 100, outputTokens: 50, cachedReadTokens: 0, cachedNonReadTokens: 0 }, cost: { costUSD: 0.01, costDeltaVsParentUSD: null },
      turns: 1,
      filesRead: [],
      filesWritten: [],
      toolCalls: [],
      outputIsDiagnostic: false,
      escalationLog: [],
      durationMs: 1000,
      workerStatus: 'done',
      terminationReason: { cause: 'finished' as const, turnsUsed: 1, hasFileArtifacts: false, usedShell: false, workerSelfAssessment: 'done' as const, wasPromoted: false },
      stageStats: {
        ...emptyStats(),
        implementing: {
          stage: 'implementing',
          entered: true,
          durationMs: 1000,
          costUSD: 0.01,
          agentTier: 'standard',
          modelFamily: null,
          model: null,
          maxIdleMs: 0,
          totalIdleMs: 0,
          activityEvents: 0,
          inputTokens: 100,
          outputTokens: 50,
          cachedReadTokens: 0, cachedNonReadTokens: 0,
          turnCount: 1,
          toolCallCount: 1,
          filesReadCount: 0,
          filesWrittenCount: 0,
        },
      },
      models: { implementer: 'gpt-5', specReviewer: null, qualityReviewer: null },
      agents: { implementer: 'standard', specReviewer: 'not_applicable', qualityReviewer: 'not_applicable' },
      concerns: [],
    };
  }

  const buildCtx = {
    route: 'delegate' as const,
    taskSpec: { filePaths: [] },
    client: 'test-client',
    mainModel: null,
  };

  it('case 1: models.implementer set → that name wins', () => {
    const rr = structuredClone(makeBaseRunResult());
    rr.models = { implementer: 'claude-sonnet', specReviewer: null, qualityReviewer: null };
    const event = buildTaskCompletedEvent({ ...buildCtx, runResult: rr });
    expect(event.implementerModel).toBe('claude-sonnet');
  });

  it('case 2: only stage model set → that name wins', () => {
    const rr = structuredClone(makeBaseRunResult());
    delete (rr as any).models;
    rr.stageStats!.implementing.model = 'gemini-2.5-pro';
    const event = buildTaskCompletedEvent({ ...buildCtx, runResult: rr });
    expect(event.implementerModel).toBe('gemini-2.5-pro');
  });

  it('case 3: nothing set → custom literal', () => {
    const rr = structuredClone(makeBaseRunResult());
    delete (rr as any).models;
    rr.stageStats!.implementing.model = null;
    const event = buildTaskCompletedEvent({ ...buildCtx, runResult: rr });
    expect(event.implementerModel).toBe('custom');
  });
});

// ── Test 12 Part A ───────────────────────────────────────────────────────
// Full reviewed-lifecycle integration: both standard and complex tiers
// transport-fail so bothUnavailable fires. The higher-work tier's result
// (standard, 56-min equivalent state) becomes salvageResult and its data
// threads into the emitted task_completed event.
//
// The module mock of @zhixuan92/multi-model-agent-core/provider is the
// *complex-tier* (escalation) provider. The primary (standard) provider is
// passed directly via resolved.provider so scoreWork picks it as the
// salvageResult. Both tiers produce transport failures, triggering
// all_tiers_unavailable.

describe('Test 12 Part A — lifecycle regression', () => {
  it('preserves implementer work via salvage when both tiers unavailable', async () => {
    const config = makeConfig();

    // Escalation (complex-tier) mock: always transport-fails with zero work.
    // This is the fallback path that the lifecycle calls via createProvider.

    // Primary (standard) provider — fails with timeout but carries 56-min of work.
    // scoreWork = turns(42) + filesWritten(2) + inputTokens/1000(47) = 91
    const primaryProvider: Provider = {
      name: 'test-standard',
      config: config.agents.standard,
      run: async () => ({
        output: '# Implemented Feature\n\nReal implementation work done before transport failure.\n',
        status: 'timeout' as const,
        usage: { inputTokens: 47000, outputTokens: 12000, cachedReadTokens: 0, cachedNonReadTokens: 0 }, cost: { costUSD: 0.87, costDeltaVsParentUSD: null },
        turns: 42,
        filesRead: ['src/feature.ts', 'tests/feature.test.ts'],
        filesWritten: ['src/feature.ts', 'tests/feature.test.ts'],
        toolCalls: ['readFile(src/feature.ts)', 'writeFile(src/feature.ts)'],
        outputIsDiagnostic: false,
        escalationLog: [],
        durationMs: 3_360_000,
      }),
    };

    const task: TaskSpec = {
      prompt: 'implement feature X with tests',
      agentType: 'standard' as const,
      timeoutMs: 300_000,
    };

    const resolved: { slot: AgentType; provider: Provider } = {
      slot: 'standard',
      provider: primaryProvider,
  
    };

    const result = await executeReviewedLifecycle(
      task,
      resolved,
      config,
      0,
      undefined,
      undefined,
      undefined,
      undefined,
      'delegate',
    );

    // The lifecycle should have set terminationReason to all_tiers_unavailable.
    expect(result.terminationReason).toBe('all_tiers_unavailable');
    expect(result.status).toBe('incomplete');
    expect(result.workerStatus).toBe('blocked');

    // Salvage: stageStats.implementing should be entered with real work.
    expect(result.stageStats).toBeDefined();
    expect(result.stageStats!.implementing.entered).toBe(true);

    // All metrics from salvage source (standard provider) must thread through.
    expect(result.durationMs).toBe(3_360_000);
    expect(result.stageStats!.implementing.durationMs).toBe(3_360_000);
    expect(result.stageStats!.implementing.costUSD).toBeCloseTo(0.87, 6);
    expect(result.stageStats!.implementing.turnCount).toBe(42);
    expect(result.stageStats!.implementing.filesWrittenCount).toBe(2);
    expect(result.stageStats!.implementing.inputTokens).toBe(47000);
    expect(result.stageStats!.implementing.outputTokens).toBe(12000);

    // Verify salvage model identity threads through.
    expect(result.models).toBeDefined();
    expect(result.models!.implementer).toBe('deepseek-v4-pro');

    // Build the event to verify end-to-end telemetry preservation.
    const event = buildTaskCompletedEvent({
      route: 'delegate',
      taskSpec: { filePaths: ['src/feature.ts'] },
      runResult: result,
      client: 'test-client',
      mainModel: null,
    });

    expect(event.terminalStatus).toBe('unavailable');
    expect(event.implementerModel).toBe('deepseek-v4-pro');
    expect(event.totalDurationMs).toBeGreaterThan(3_000_000);
    expect(event.stages).toHaveLength(1);

    const implStage = event.stages[0]!;
    expect(implStage.name).toBe('implementing');
    expect(implStage.tier).toBe('standard');
    expect(implStage.durationMs).toBe(3_360_000);
    expect(implStage.costUSD).toBeCloseTo(0.87, 6);
    expect(implStage.turnCount).toBe(42);
    expect(implStage.filesWrittenCount).toBe(2);
    expect(implStage.inputTokens).toBe(47000);
    expect(implStage.outputTokens).toBe(12000);
  });
});

// ── Test 15 — Item 5 regression ─────────────────────────────────────────
// Salvage stages from adaptForAllTiersUnavailable must emit 0 not null for
// idle fields. Null was a SQL aggregation hazard on the wire; entered=false
// already signals 'stage didn't run'.

describe('Test 15 — Item 5: idle fields are 0 not null', () => {
  it('emptyStats() returns 0 for maxIdleMs/totalIdleMs/activityEvents on every stage', () => {
    const stats = emptyStats();
    const stages = Object.values(stats);
    for (const s of stages) {
      expect(s.maxIdleMs).toBe(0);
      expect(s.totalIdleMs).toBe(0);
      expect(s.activityEvents).toBe(0);
    }
  });

  it('salvage-style RunResult with idle=0 passes Zod validation', () => {
    const stats = emptyStats();
    const runResult: RunResult = {
      output: 'unavailable — both tiers transport-failed',
      status: 'incomplete',
      usage: { inputTokens: 0, outputTokens: 0, cachedReadTokens: 0, cachedNonReadTokens: 0 }, cost: { costUSD: 0, costDeltaVsParentUSD: null },
      turns: 0,
      filesRead: [],
      filesWritten: [],
      toolCalls: [],
      outputIsDiagnostic: true,
      escalationLog: [],
      durationMs: 1000,
      workerStatus: 'blocked',
      terminationReason: 'all_tiers_unavailable',
      stageStats: {
        ...stats,
        implementing: {
          ...stats.implementing,
          entered: true,
          durationMs: 3_360_000,
          costUSD: 0.87,
          agentTier: 'standard',
          modelFamily: 'deepseek',
          model: 'deepseek-v4-pro',
          inputTokens: 47000,
          outputTokens: 12000,
          cachedReadTokens: 0, cachedNonReadTokens: 0,
          turnCount: 42,
          toolCallCount: 4,
          filesReadCount: 2,
          filesWrittenCount: 2,
        },
      },
      models: { implementer: 'deepseek-v4-pro', specReviewer: null, qualityReviewer: null },
      agents: {
        implementer: 'standard',
        implementerToolMode: 'full',
        specReviewer: 'not_applicable',
        qualityReviewer: 'not_applicable',
        fallbackOverrides: [],
      },
      concerns: [],
    };

    const event = buildTaskCompletedEvent({
      route: 'delegate',
      taskSpec: { filePaths: [] },
      runResult,
      client: 'test-client',
      mainModel: null,
    });

    const result = ValidatedTaskCompletedEventSchema.safeParse(event);
    expect(result.success).toBe(true);

    // Verify the implementing stage from salvage has 0 not null for idle fields.
    const implStage = event.stages.find(s => s.name === 'implementing')!;
    expect(implStage.maxIdleMs).toBe(0);
    expect(implStage.totalIdleMs).toBe(0);
  });

  it('maxIdleMs: null fails Zod validation (nullable dropped)', () => {
    const runResult: RunResult = {
      output: 'test',
      status: 'incomplete',
      usage: { inputTokens: 0, outputTokens: 0, cachedReadTokens: 0, cachedNonReadTokens: 0 }, cost: { costUSD: 0, costDeltaVsParentUSD: null },
      turns: 0,
      filesRead: [],
      filesWritten: [],
      toolCalls: [],
      outputIsDiagnostic: true,
      escalationLog: [],
      durationMs: 1000,
      workerStatus: 'blocked',
      terminationReason: 'all_tiers_unavailable',
      stageStats: emptyStats(),
      models: { implementer: null, specReviewer: null, qualityReviewer: null },
      agents: {
        implementer: 'not_applicable',
        implementerToolMode: 'none',
        specReviewer: 'not_applicable',
        qualityReviewer: 'not_applicable',
        fallbackOverrides: [],
      },
      concerns: [],
    };

    const event = buildTaskCompletedEvent({
      route: 'delegate',
      taskSpec: { filePaths: [] },
      runResult,
      client: 'test-client',
      mainModel: null,
    });

    // Force a null into a stage field that the schema now rejects.
    (event as Record<string, unknown>).stages = [{
      name: 'implementing',
      round: 0,
      durationMs: null,
      costUSD: null,
      tier: null,
      model: null,
      maxIdleMs: null,
      totalIdleMs: null,
    }];

    const result = ValidatedTaskCompletedEventSchema.safeParse(event);
    expect(result.success).toBe(false);
  });
});
