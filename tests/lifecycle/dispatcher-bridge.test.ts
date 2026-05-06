import { describe, it, expect } from 'vitest';
import * as os from 'node:os';
import { runTaskViaDispatcher } from '../../packages/core/src/lifecycle/dispatcher-bridge.js';
import type { TaskSpec, RunResult, MultiModelConfig, Provider } from '../../packages/core/src/types.js';
import type { ResolvedAgent } from '../../packages/core/src/escalation/agent-resolver.js';

function mockProvider(reply: string, name: 'standard' | 'complex' = 'standard'): Provider {
  return {
    name,
    config: { type: 'claude', model: 'mock' } as Provider['config'],
    run: async () => ({
      output: reply,
      status: 'ok',
      usage: { inputTokens: 0, outputTokens: 0 },
      turns: 0,
      filesRead: [],
      filesWritten: [],
      toolCalls: [],
      outputIsDiagnostic: false,
      escalationLog: [],
      parsedFindings: null,
    } as RunResult),
  };
}

function makeConfig(): MultiModelConfig {
  return {
    agents: {
      standard: { type: 'mock', timeoutMs: 60_000 } as unknown as MultiModelConfig['agents']['standard'],
      complex: { type: 'mock', timeoutMs: 60_000 } as unknown as MultiModelConfig['agents']['complex'],
    },
    defaults: { timeoutMs: 60_000, stallTimeoutMs: 30_000, maxCostUSD: 5, tools: 'full', sandboxPolicy: 'cwd-only' },
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
      reviewPolicy: 'none', // skip spec/quality/diff for the smoke test
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
    // Implementer returns a structured report, reviewer (same mock) approves.
    // Both providers return the same approve-summary so spec round 1 +
    // quality round 1 both pass.
    const provider: Provider = {
      name: 'standard',
      config: { type: 'claude', model: 'mock' } as Provider['config'],
      run: async (prompt: string) => {
        // Reviewers see review prompts; implementers see task prompts.
        const isReview = /reviewer|## Summary/i.test(prompt);
        return {
          output: '## Summary\napproved\n\nDone.',
          status: 'ok',
          usage: { inputTokens: 0, outputTokens: 0 },
          turns: 0,
          filesRead: [],
          filesWritten: [],
          toolCalls: [],
          outputIsDiagnostic: false,
          escalationLog: [],
          parsedFindings: null,
          structuredReport: { summary: 'approved', filesChanged: [], validationsRun: [], deviationsFromBrief: [], unresolved: [] } as unknown as RunResult['structuredReport'],
          ...(isReview ? {} : { implementationReport: { summary: 'approved', filesChanged: [], validationsRun: [], deviationsFromBrief: [], unresolved: [] } as unknown as RunResult['implementationReport'] }),
        } as RunResult;
      },
    };
    const resolved: ResolvedAgent = { slot: 'standard', provider };
    const task: TaskSpec = {
      prompt: 'do the thing',
      cwd: os.tmpdir(),
      reviewPolicy: 'full',
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
    expect(result.status).toBe('ok');
  });

  it('captures provider error in RunResult on failure', async () => {
    const provider: Provider = {
      name: 'standard',
      config: { type: 'claude', model: 'mock' } as Provider['config'],
      run: async () => {
        throw new Error('network down');
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
