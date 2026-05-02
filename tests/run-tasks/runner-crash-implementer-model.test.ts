import { describe, it, expect, vi } from 'vitest';
import { buildTaskCompletedEvent } from '../../packages/core/src/telemetry/event-builder.js';
import { executeReviewedLifecycle } from '../../packages/core/src/run-tasks/reviewed-lifecycle.js';
import type { MultiModelConfig, TaskSpec, AgentType, Provider } from '../../packages/core/src/types.js';

vi.mock('fs/promises', () => ({
  readFile: vi.fn().mockResolvedValue('// mock file content\nconst x = 1;\n'),
}));

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

describe('Item 18: runner_crash preserves resolved implementerModel', () => {
  it('emits implementerModel=resolved config model, not "custom"', async () => {
    const config = makeConfig();
    const resolvedModel = config.agents.standard.model;

    const crashingProvider: Provider = {
      name: 'test-standard',
      config: config.agents.standard,
      run: async () => {
        throw new Error('simulated runner crash');
      },
    };

    const task: TaskSpec = {
      prompt: 'implement feature X',
      agentType: 'standard' as const,
      reviewPolicy: 'off' as const,
      timeoutMs: 300_000,
    };

    const resolved: { slot: AgentType; provider: Provider; capabilityOverride: boolean } = {
      slot: 'standard',
      provider: crashingProvider,
      capabilityOverride: false,
    };

    const result = await executeReviewedLifecycle(
      task, resolved, config, 0,
      undefined, undefined, undefined, undefined, 'delegate',
    );

    expect(result.status).toBe('error');
    expect(result.errorCode).toBe('runner_crash');
    expect(result.models?.implementer).toBe(resolvedModel);

    const event = buildTaskCompletedEvent({
      route: 'delegate',
      taskSpec: { filePaths: [] },
      runResult: result,
      client: 'test-client',
      parentModel: null,
    });

    expect(event.implementerModel).toBe('deepseek-v4-pro');
    expect(event.implementerModel).not.toBe('custom');
  });
});
