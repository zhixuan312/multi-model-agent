import { describe, it, expect } from 'vitest';
import { executeReviewedLifecycle } from '../packages/core/src/run-tasks/reviewed-lifecycle.js';
import { mockProvider } from './contract/fixtures/mock-providers.js';
import type {
  MultiModelConfig,
  TaskSpec,
  AgentType,
  Provider,
} from '../packages/core/src/types.js';

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

function makeResolved(config: MultiModelConfig): {
  slot: AgentType;
  provider: Provider;
  capabilityOverride: boolean;
} {
  return {
    slot: 'standard',
    provider: {
      name: 'mock-standard',
      config: config.agents.standard,
      run: mockProvider({ stage: 'ok', output: 'done' }).run,
    },
    capabilityOverride: false,
  };
}

const noopRecorder = {
  recordTaskCompleted: () => {},
  recordSessionStarted: () => {},
  recordInstallChanged: () => {},
  recordSkillInstalled: () => {},
};

const explodingRecorder = {
  recordTaskCompleted: () => {
    throw new Error('boom');
  },
  recordSessionStarted: () => {
    throw new Error('boom');
  },
  recordInstallChanged: () => {
    throw new Error('boom');
  },
  recordSkillInstalled: () => {
    throw new Error('boom');
  },
};

describe('Sam test — telemetry failure NEVER throws to the user task', () => {
  it('runs identically when the recorder throws on every call', async () => {
    const config = makeConfig();
    const task: TaskSpec = {
      prompt: 'test',
      reviewPolicy: 'off',
    };
    const resolved = makeResolved(config);

    const control = await executeReviewedLifecycle(
      task,
      resolved,
      config,
      0,
      undefined,
      undefined,
      undefined,
      noopRecorder,
      'delegate',
      'claude-code',
      'direct',
    );

    const exploded = await executeReviewedLifecycle(
      task,
      resolved,
      config,
      0,
      undefined,
      undefined,
      undefined,
      explodingRecorder,
      'delegate',
      'claude-code',
      'direct',
    );

    // RunResult shapes must be identical — telemetry never affects user task results.
    expect({ ...exploded, stageStats: undefined }).toEqual({
      ...control,
      stageStats: undefined,
    });
  });
});
