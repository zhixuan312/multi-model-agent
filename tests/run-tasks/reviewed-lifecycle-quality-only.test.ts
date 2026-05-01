import { describe, it, expect, vi } from 'vitest';
import { executeReviewedLifecycle } from '../../packages/core/src/run-tasks/reviewed-lifecycle.js';
import type { MultiModelConfig, TaskSpec, AgentType, Provider, RunResult } from '../../packages/core/src/types.js';

vi.mock('fs/promises', () => ({
  readFile: vi.fn().mockResolvedValue('// mock file content\nconst x = 1;\n'),
}));

const NARRATIVE_WORKER_OUTPUT = [
  '# Audit Report',
  '### 1. Silent error swallowing in parseConfig',
  'Severity: high',
  'Location: src/a.ts:10',
  'The function silently swallows errors and returns null — this is the issue and it needs a guard added at the top.',
].join('\n');

const REVIEWER_OUTPUT = [
  '```json',
  JSON.stringify([{
    id: 'F1', severity: 'high',
    claim: 'silent error swallowing in parseConfig',
    evidence: 'The function silently swallows errors and returns null — this is the issue and it needs a guard added at the top.',
    reviewerConfidence: 80,
  }]),
  '```',
].join('\n');

// Mock the provider factory so every tier created during escalation gets a mock.
// Pattern adapted from tests/reviewed-execution/review-policy.test.ts.
vi.mock('@zhixuan92/multi-model-agent-core/provider', () => ({
  createProvider: (slot: string) => ({
    name: slot,
    config: { type: 'openai-compatible' as const, model: `${slot}-model`, baseUrl: 'https://ex.invalid/v1' },
    run: async (prompt: string) => {
      const isReviewer = typeof prompt === 'string' && prompt.includes('reviewerConfidence');
      if (isReviewer) {
        return {
          output: REVIEWER_OUTPUT,
          status: 'ok' as const,
          usage: { inputTokens: 50, outputTokens: 25, totalTokens: 75, costUSD: 0.005 },
          turns: 1,
          filesRead: [],
          filesWritten: [],
          toolCalls: [],
          outputIsDiagnostic: false,
          escalationLog: [],
        };
      }
      return {
        output: NARRATIVE_WORKER_OUTPUT,
        status: 'ok' as const,
        usage: { inputTokens: 100, outputTokens: 50, totalTokens: 150, costUSD: 0.01 },
        turns: 1,
        filesRead: ['src/a.ts'],
        filesWritten: ['report.md'],
        toolCalls: ['readFile(src/a.ts)', 'writeFile(report.md)'],
        outputIsDiagnostic: false,
        escalationLog: [],
      };
    },
  }),
}));

function makeConfig(): MultiModelConfig {
  return {
    agents: {
      standard: {
        type: 'openai-compatible',
        model: 'gpt-5',
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

describe('executeReviewedLifecycle — quality_only', () => {
  it('throws when called with quality_only for an artifact-producing route', async () => {
    const config = makeConfig();
    const task: TaskSpec = {
      prompt: 'implement feature',
      agentType: 'complex' as const,
      reviewPolicy: 'quality_only' as const,
    };
    const resolved: { slot: AgentType; provider: Provider; capabilityOverride: boolean } = {
      slot: 'standard',
      provider: {
        name: 'mock-standard',
        config: config.agents.standard,
        run: async () => ({
          output: 'done',
          status: 'ok' as const,
          usage: { inputTokens: 10, outputTokens: 5, totalTokens: 15, costUSD: 0.001 },
          turns: 1,
          filesRead: [],
          filesWritten: [],
          toolCalls: [],
          outputIsDiagnostic: false,
          escalationLog: [],
        }),
      },
      capabilityOverride: false,
    };

    await expect(
      executeReviewedLifecycle(task, resolved, config, 0, undefined, undefined, undefined, undefined, 'delegate'),
    ).rejects.toThrow(/quality_only.*read-only/i);
  });

  it('skips spec_review and runs quality_review when reviewPolicy is quality_only', async () => {
    const config = makeConfig();
    const task: TaskSpec = {
      prompt: 'audit this code',
      agentType: 'complex' as const,
      reviewPolicy: 'quality_only' as const,
    };
    const resolved: { slot: AgentType; provider: Provider; capabilityOverride: boolean } = {
      slot: 'standard',
      provider: {
        name: 'mock-standard',
        config: config.agents.standard,
        run: async () => ({
          output: '## Summary\ndone\n\n## Files changed\n- report.md: added\n\n## Validations run\n- lint: passed\n\n## Deviations from brief\n\n## Unresolved\n',
          status: 'ok' as const,
          usage: { inputTokens: 100, outputTokens: 50, totalTokens: 150, costUSD: 0.01 },
          turns: 1,
          filesRead: ['src/a.ts'],
          filesWritten: ['report.md'],
          toolCalls: ['writeFile(report.md)'],
          outputIsDiagnostic: false,
          escalationLog: [],
        }),
      },
      capabilityOverride: false,
    };

    const result = await executeReviewedLifecycle(task, resolved, config, 0, undefined, undefined, undefined, undefined, 'audit');

    expect(result.stageStats).toBeDefined();
    expect(result.stageStats!.spec_review.entered).toBe(false);
    expect(result.stageStats!.quality_review.entered).toBe(true);
    expect(result.specReviewStatus).toBe('not_applicable');
  });

  it('populates reviewRounds on the success path', async () => {
    const config = makeConfig();
    const task: TaskSpec = {
      prompt: 'audit this code',
      agentType: 'complex' as const,
      reviewPolicy: 'quality_only' as const,
    };
    const resolved: { slot: AgentType; provider: Provider; capabilityOverride: boolean } = {
      slot: 'standard',
      provider: {
        name: 'mock-standard',
        config: config.agents.standard,
        run: async () => ({
          output: '## Summary\ndone\n\n## Files changed\n- report.md: added\n\n## Validations run\n- lint: passed\n\n## Deviations from brief\n\n## Unresolved\n',
          status: 'ok' as const,
          usage: { inputTokens: 100, outputTokens: 50, totalTokens: 150, costUSD: 0.01 },
          turns: 1,
          filesRead: ['src/a.ts'],
          filesWritten: ['report.md'],
          toolCalls: ['writeFile(report.md)'],
          outputIsDiagnostic: false,
          escalationLog: [],
        }),
      },
      capabilityOverride: false,
    };

    const result = await executeReviewedLifecycle(task, resolved, config, 0, undefined, undefined, undefined, undefined, 'audit');
    expect(result.reviewRounds).toBeDefined();
    expect(result.reviewRounds!.spec).toBeGreaterThanOrEqual(0);
    expect(result.reviewRounds!.quality).toBeGreaterThanOrEqual(0);
  });

  it('sets specReviewer to null and qualityReviewer to reviewModel', async () => {
    const config = makeConfig();
    const task: TaskSpec = {
      prompt: 'audit this code',
      agentType: 'complex' as const,
      reviewPolicy: 'quality_only' as const,
    };
    const resolved: { slot: AgentType; provider: Provider; capabilityOverride: boolean } = {
      slot: 'standard',
      provider: {
        name: 'mock-standard',
        config: config.agents.standard,
        run: async () => ({
          output: '## Summary\ndone\n\n## Files changed\n- report.md: added\n\n## Validations run\n- lint: passed\n\n## Deviations from brief\n\n## Unresolved\n',
          status: 'ok' as const,
          usage: { inputTokens: 100, outputTokens: 50, totalTokens: 150, costUSD: 0.01 },
          turns: 1,
          filesRead: ['src/a.ts'],
          filesWritten: ['report.md'],
          toolCalls: ['writeFile(report.md)'],
          outputIsDiagnostic: false,
          escalationLog: [],
        }),
      },
      capabilityOverride: false,
    };

    const result = await executeReviewedLifecycle(task, resolved, config, 0, undefined, undefined, undefined, undefined, 'audit');
    expect(result.models).toBeDefined();
    expect(result.models!.specReviewer).toBeNull();
    expect(result.models!.qualityReviewer).toBeTruthy();
  });

  it('uses qualityReviewPromptBuilder when provided (annotation model)', async () => {
    const config = makeConfig();
    const task: TaskSpec = {
      prompt: 'audit this code',
      agentType: 'complex' as const,
      reviewPolicy: 'quality_only' as const,
    };

    const resolved: { slot: AgentType; provider: Provider; capabilityOverride: boolean } = {
      slot: 'standard',
      provider: {
        name: 'mock-standard',
        config: config.agents.standard,
        run: async () => ({
          output: NARRATIVE_WORKER_OUTPUT,
          status: 'ok' as const,
          usage: { inputTokens: 100, outputTokens: 50, totalTokens: 150, costUSD: 0.01 },
          turns: 1,
          filesRead: ['src/a.ts'],
          filesWritten: ['report.md'],
          toolCalls: ['writeFile(report.md)'],
          outputIsDiagnostic: false,
          escalationLog: [],
        }),
      },
      capabilityOverride: false,
    };

    let builderCalled = false;
    let receivedBrief = '';

    const builder = (ctx: { workerOutput: string; brief: string }) => {
      builderCalled = true;
      receivedBrief = ctx.brief;
      return `Annotation prompt\n\n${ctx.workerOutput}\n\nreviewerConfidence: score each finding 0-100`;
    };

    const result = await executeReviewedLifecycle(
      task, resolved, config, 0,
      undefined, undefined, undefined, undefined, 'audit',
      undefined, undefined, undefined,
      builder,
    );

    expect(builderCalled).toBe(true);
    expect(receivedBrief).toBe('audit this code');
    expect(result.stageStats!.quality_review.entered).toBe(true);
    // Annotated findings from the annotation path
    expect(result.annotatedFindings).toBeDefined();
    expect(result.annotatedFindings!.length).toBeGreaterThanOrEqual(1);
    expect(result.annotatedFindings![0]!.severity).toBe('high');
    expect(result.annotatedFindings![0]!.reviewerConfidence).toBe(80);
    expect(result.annotatedFindings![0]!.evidenceGrounded).toBe(true);
  });

  it('funnels annotated findings into concerns[] and V3 findingsBySeverity roll-up', async () => {
    const config = makeConfig();
    const task: TaskSpec = {
      prompt: 'audit this code',
      agentType: 'complex' as const,
      reviewPolicy: 'quality_only' as const,
    };

    const resolved: { slot: AgentType; provider: Provider; capabilityOverride: boolean } = {
      slot: 'standard',
      provider: {
        name: 'mock-standard',
        config: config.agents.standard,
        run: async () => ({
          output: NARRATIVE_WORKER_OUTPUT,
          status: 'ok' as const,
          usage: { inputTokens: 100, outputTokens: 50, totalTokens: 150, costUSD: 0.01 },
          turns: 1,
          filesRead: ['src/a.ts'],
          filesWritten: ['report.md'],
          toolCalls: ['writeFile(report.md)'],
          outputIsDiagnostic: false,
          escalationLog: [],
        }),
      },
      capabilityOverride: false,
    };

    const builder = (ctx: { workerOutput: string; brief: string }) =>
      `Annotation prompt\n\n${ctx.workerOutput}\n\nreviewerConfidence: score each finding 0-100`;

    const result = await executeReviewedLifecycle(
      task, resolved, config, 0,
      undefined, undefined, undefined, undefined, 'audit',
      undefined, undefined, undefined,
      builder,
    );

    // Concerns populated from annotated findings with source='quality_review'
    expect(result.concerns).toBeDefined();
    const qrConcerns = result.concerns!.filter(c => c.source === 'quality_review');
    expect(qrConcerns.length).toBeGreaterThanOrEqual(1);
    expect(qrConcerns[0]!.severity).toBe('high');
    expect(qrConcerns[0]!.message).toContain('[F1]');
    expect(qrConcerns[0]!.message).toContain('silent error swallowing');

    // V3 telemetry: buildTaskCompletedEvent rolls concerns into findingsBySeverity
    const { buildTaskCompletedEvent } = await import('../../packages/core/src/telemetry/event-builder.js');
    const event = buildTaskCompletedEvent({
      route: 'audit',
      taskSpec: { filePaths: [] },
      runResult: result,
      client: 'test-client',
      parentModel: null,
      reviewPolicy: 'quality_only',
    });

    const qrStage = event.stages.find(s => s.name === 'quality_review');
    expect(qrStage).toBeDefined();
    expect(qrStage!.findingsBySeverity).toBeDefined();
    expect(qrStage!.findingsBySeverity.high).toBeGreaterThanOrEqual(1);
  });
});
