import { describe, it, expect } from 'vitest';
import * as os from 'node:os';
import { runTaskViaDispatcher } from '../../packages/core/src/lifecycle/task-runner.js';
import { InMemoryContextBlockStore } from '../../packages/core/src/stores/context-block-tool.js';
import type { TaskSpec, MultiModelConfig, Provider } from '../../packages/core/src/types.js';
import type { ResolvedAgent } from '../../packages/core/src/escalation/agent-resolver.js';
import type { Session, SessionOpts, TurnResult } from '../../packages/core/src/types/run-result.js';

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

function makeRecordingProvider(seenPrompts: string[]): Provider {
  return {
    name: 'standard',
    config: { type: 'claude', model: 'mock' } as Provider['config'],
    openSession(_opts: SessionOpts): Session {
      return {
        async send(instruction: string): Promise<TurnResult> {
          seenPrompts.push(instruction);
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
          };
        },
        async close() { /* no-op */ },
      };
    },
  };
}

describe('Gap 1 — contextBlockIds expansion through runTaskViaDispatcher', () => {
  it('prepends block content to the worker prompt and shares one task reference', async () => {
    const store = new InMemoryContextBlockStore({ maxBytes: 4096, maxEntries: 16 });
    const blockContent = 'PRIOR_AUDIT_FINDINGS_MARKER_42';
    const { id } = store.register(blockContent);

    const seenPrompts: string[] = [];
    const provider = makeRecordingProvider(seenPrompts);
    const resolved: ResolvedAgent = { slot: 'standard', provider };
    const task: TaskSpec = {
      prompt: 'audit goal.md',
      contextBlockIds: [id],
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
      contextBlockStore: store,
    });

    expect(result.status).toBe('ok');
    expect(seenPrompts.length).toBeGreaterThan(0);
    expect(seenPrompts.some(p => p.includes(blockContent))).toBe(true);
  });

  it('is a no-op when no contextBlockStore is provided', async () => {
    const seenPrompts: string[] = [];
    const provider = makeRecordingProvider(seenPrompts);
    const resolved: ResolvedAgent = { slot: 'standard', provider };
    const task: TaskSpec = {
      prompt: 'audit without context',
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

    expect(result.status).toBe('ok');
    expect(seenPrompts[0]).toBe('audit without context');
  });

  it('expandContextBlocks is idempotent — second call does not double-prepend', async () => {
    const store = new InMemoryContextBlockStore({ maxBytes: 4096, maxEntries: 16 });
    const blockContent = 'IDEMPOTENT_MARKER';
    const { id } = store.register(blockContent);

    const seenPrompts: string[] = [];
    const provider = makeRecordingProvider(seenPrompts);
    const resolved: ResolvedAgent = { slot: 'standard', provider };
    const task: TaskSpec = {
      prompt: 'audit',
      contextBlockIds: [id],
      cwd: os.tmpdir(),
      reviewPolicy: 'none',
      timeoutMs: 60_000,
      tools: 'none',
    };

    await runTaskViaDispatcher({
      task,
      resolved,
      config: makeConfig(),
      taskIndex: 0,
      route: 'delegate',
      contextBlockStore: store,
    });

    const occurrences = (seenPrompts[0]?.match(/IDEMPOTENT_MARKER/g) ?? []).length;
    expect(occurrences).toBe(1);
  });
});
