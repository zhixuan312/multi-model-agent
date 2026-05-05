import { describe, it, expect, vi } from 'vitest';
import { buildTaskCompletedEvent } from '../../packages/core/src/events/event-builder.js';
import { executeReviewedLifecycle } from '../../packages/core/src/lifecycle/reviewed-lifecycle.js';
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
  it('emits implementerModel from resolved provider model, not "custom"', async () => {
    const config = makeConfig();

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
      reviewPolicy: 'none' as const,
      timeoutMs: 300_000,
    };

    const resolved: { slot: AgentType; provider: Provider } = {
      slot: 'standard',
      provider: crashingProvider,
  
    };

    const result = await executeReviewedLifecycle(
      task, resolved, config, 0,
      undefined, undefined, undefined, undefined, 'delegate',
    );

    expect(result.status).toBe('error');
    expect(result.errorCode).toBe('runner_crash');
    expect(result.models?.implementer).toBe('deepseek-v4-pro');

    const event = buildTaskCompletedEvent({
      route: 'delegate',
      taskSpec: { filePaths: [] },
      runResult: result,
      client: 'test-client',
      mainModel: null,
    });

    expect(event.implementerModel).toBe('deepseek-v4-pro');
    expect(event.implementerModel).not.toBe('custom');
  });

  it('uses resolved.provider.config.model when it differs from config.agents[slot].model', async () => {
    const config = makeConfig();
    const slotModel = config.agents.standard.model; // 'deepseek-v4-pro'

    const crashingProvider: Provider = {
      name: 'test-standard',
      config: {
        ...config.agents.standard,
        model: 'gemini-2.5-pro', // differs from the static slot model
      },
      run: async () => {
        throw new Error('simulated runner crash');
      },
    };

    const task: TaskSpec = {
      prompt: 'implement feature X',
      agentType: 'standard' as const,
      reviewPolicy: 'none' as const,
      timeoutMs: 300_000,
    };

    const resolved: { slot: AgentType; provider: Provider } = {
      slot: 'standard',
      provider: crashingProvider,
  
    };

    const result = await executeReviewedLifecycle(
      task, resolved, config, 0,
      undefined, undefined, undefined, undefined, 'delegate',
    );

    expect(result.status).toBe('error');
    expect(result.errorCode).toBe('runner_crash');
    // The implementer model should be the provider's model, not the static slot model
    expect(result.models?.implementer).toBe('gemini-2.5-pro');
    expect(result.models?.implementer).not.toBe(slotModel);

    const event = buildTaskCompletedEvent({
      route: 'delegate',
      taskSpec: { filePaths: [] },
      runResult: result,
      client: 'test-client',
      mainModel: null,
    });

    expect(event.implementerModel).toBe('gemini-2.5-pro');
    expect(event.implementerModel).not.toBe('custom');
    expect(event.implementerModel).not.toBe(slotModel);
  });
});
