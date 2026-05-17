import { describe, it, expect } from 'vitest';
import * as os from 'node:os';
import { runTaskViaDispatcher } from '../../packages/core/src/lifecycle/task-runner.js';
import type { TaskSpec, MultiModelConfig, Provider } from '../../packages/core/src/types.js';
import type { ResolvedAgent } from '../../packages/core/src/escalation/agent-resolver.js';
import type { Session, SessionOpts, TurnResult } from '../../packages/core/src/types/run-result.js';
import { __setCoreTestProviderOverride } from '@zhixuan92/multi-model-agent-core';

function mockProvider(reply: string, name: 'standard' | 'complex' = 'standard'): Provider {
  return {
    name,
    config: { type: 'claude', model: 'mock' } as Provider['config'],
    openSession(_opts: SessionOpts): Session {
      return {
        async send(): Promise<TurnResult> {
          return {
            output: reply,
            usage: { inputTokens: 0, outputTokens: 0, cachedReadTokens: 0, cachedNonReadTokens: 0 },
            turns: 1,
            durationMs: 0,
            filesRead: [],
            filesWritten: [],
            toolCallsByName: {},
            costUSD: 0,
            terminationReason: 'ok',
            workerSelfAssessment: 'done',
          };
        },
        async close() { /* no-op */ },
      };
    },
  };
}

function makeConfig(): MultiModelConfig {
  return {
    agents: {
      standard: { type: 'mock', timeoutMs: 60_000 } as unknown as MultiModelConfig['agents']['standard'],
      complex: { type: 'mock', timeoutMs: 60_000 } as unknown as MultiModelConfig['agents']['complex'],
    },
    defaults: { timeoutMs: 60_000, stallTimeoutMs: 30_000, tools: 'full', sandboxPolicy: 'cwd-only' },
    server: {
      bind: '127.0.0.1', port: 7337,
      auth: { tokenFile: '/tmp/x' },
      limits: { maxBodyBytes: 1024, batchTtlMs: 60_000, idleProjectTimeoutMs: 60_000, projectCap: 1, maxBatchCacheSize: 10, maxContextBlockBytes: 1024, maxContextBlocksPerProject: 10, shutdownDrainMs: 1000 },
      autoUpdateSkills: false,
    },
    research: {
      brave: { apiKeys: [], timeoutMs: 1000, maxResultsPerQuery: 1, perCallBackoffMs: 0 },
      fetch: { maxRedirects: 0, connectTimeoutMs: 1000, totalDeadlineMs: 1000, maxBodyBytes: 1024, allowPrivateNetwork: false },
      builtinAdapters: { arxiv: false, semanticScholar: false, githubSearch: false, genericRss: false },
      userSources: [], fetchAllowlistExtra: [],
    },
  } as unknown as MultiModelConfig;
}

describe('runTaskViaDispatcher (Step 7a smoke test)', () => {
  it('runs a simple task via the dispatcher and returns a RunResult', async () => {
    const provider = mockProvider('## Summary\napproved\n\nDone.');
    const resolved: ResolvedAgent = { slot: 'standard', provider };
    const task: TaskSpec = {
      prompt: 'do the thing',
      cwd: os.tmpdir(),
      reviewPolicy: 'none',
      timeoutMs: 60_000,
      tools: 'none',
    };

    const result = await runTaskViaDispatcher({
      task,
      resolved,
      config: makeConfig(),
      taskIndex: 0,
      route: 'delegate',
    });

    expect(result).toBeDefined();
    expect(result.output).toContain('approved');
    expect(result.status).toBe('ok');
  });

  it('runs reviewPolicy=full through spec+quality chains when reviewers approve', async () => {
    process.env.MMAGENT_TEST_PROVIDER_OVERRIDE = '1';
    const mock: Provider = {
      name: 'standard',
      config: { type: 'claude', model: 'mock' } as Provider['config'],
      openSession(_opts: SessionOpts): Session {
        return {
          async send(): Promise<TurnResult> {
            return {
              output: '## Summary\napproved\n\nDone.',
              usage: { inputTokens: 0, outputTokens: 0, cachedReadTokens: 0, cachedNonReadTokens: 0 },
              turns: 1,
              durationMs: 0,
              filesRead: [],
              filesWritten: [],
              toolCallsByName: {},
              costUSD: 0,
              terminationReason: 'ok',
              workerSelfAssessment: 'done',
            };
          },
          async close() { /* no-op */ },
        };
      },
    };
    __setCoreTestProviderOverride(mock);
    const provider: Provider = mock;
    const resolved: ResolvedAgent = { slot: 'standard', provider };
    const task: TaskSpec = {
      prompt: 'do the thing',
      cwd: os.tmpdir(),
      reviewPolicy: 'full',
      timeoutMs: 60_000,
      tools: 'none',
    };

    try {
      const result = await runTaskViaDispatcher({
        task,
        resolved,
        config: makeConfig(),
        taskIndex: 0,
        route: 'delegate',
      });

      expect(result).toBeDefined();
      expect(result.status).toBe('ok');
    } finally {
      __setCoreTestProviderOverride(null);
      delete process.env.MMAGENT_TEST_PROVIDER_OVERRIDE;
    }
  });

  it('captures provider error in RunResult on failure', async () => {
    const provider: Provider = {
      name: 'standard',
      config: { type: 'claude', model: 'mock' } as Provider['config'],
      openSession(_opts: SessionOpts): Session {
        return {
          async send(): Promise<TurnResult> {
            throw new Error('network down');
          },
          async close() { /* no-op */ },
        };
      },
    };
    const resolved: ResolvedAgent = { slot: 'standard', provider };
    const task: TaskSpec = {
      prompt: 'failing task',
      cwd: os.tmpdir(),
      reviewPolicy: 'none',
      timeoutMs: 60_000,
      tools: 'none',
    };

    const result = await runTaskViaDispatcher({
      task,
      resolved,
      config: makeConfig(),
      taskIndex: 0,
      route: 'delegate',
    });

    expect(result.status).toBe('error');
    expect(result.errorCode).toBeDefined();
  });
});
