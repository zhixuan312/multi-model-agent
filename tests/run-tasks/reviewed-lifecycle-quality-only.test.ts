import { describe, it, expect, vi } from 'vitest';
import { executeReviewedLifecycle } from '../../packages/core/src/run-tasks/reviewed-lifecycle.js';
import type { MultiModelConfig, TaskSpec, AgentType, Provider, RunResult } from '../../packages/core/src/types.js';

vi.mock('fs/promises', () => ({
  readFile: vi.fn().mockResolvedValue('// mock file content\nconst x = 1;\n'),
}));

// Mock the provider factory so every tier created during escalation gets a mock.
// Pattern adapted from tests/reviewed-execution/review-policy.test.ts.
vi.mock('@zhixuan92/multi-model-agent-core/provider', () => ({
  createProvider: (slot: string) => ({
    name: slot,
    config: { type: 'openai-compatible' as const, model: `${slot}-model`, baseUrl: 'https://ex.invalid/v1' },
    run: async () => ({
      output: '## Summary\napproved\n\n## Files changed\n\n## Validations run\n\n## Deviations from brief\n\n## Unresolved\n',
      status: 'ok' as const,
      usage: { inputTokens: 50, outputTokens: 25, totalTokens: 75, costUSD: 0.005 },
      turns: 1,
      filesRead: [],
      filesWritten: [],
      toolCalls: [],
      outputIsDiagnostic: false,
      escalationLog: [],
    }),
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
});
