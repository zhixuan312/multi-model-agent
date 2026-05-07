import { describe, it, expect } from 'vitest';
import { executeDelegate } from '../../packages/core/src/lifecycle/executors/delegate.js';
import type { ExecutionContext } from '../../packages/core/src/lifecycle/lifecycle-context.js';
import type { ProjectContext } from '../../packages/core/src/stores/project-context-registry.js';

// ---------------------------------------------------------------------------
// Test helpers
// ---------------------------------------------------------------------------

function makeCtx(overrides?: Partial<ExecutionContext>): ExecutionContext {
  const pc = {
    cwd: '/tmp/test',
    batchCache: {
      remember: () => 'test-batch-id',
      abort: () => {},
      complete: () => {},
    },
  } as unknown as ProjectContext;

  return {
    projectContext: pc,
    config: {
      agents: {
        standard: { type: 'openai-compatible', model: 'gpt-4', baseUrl: 'https://example.invalid/v1' },
        complex: { type: 'openai-compatible', model: 'gpt-4', baseUrl: 'https://example.invalid/v1' },
      },
      defaults: { timeoutMs: 600_000, tools: 'full', sandboxPolicy: 'cwd-only', maxCostUSD: 10 },
      server: {
        bind: '127.0.0.1', port: 7337,
        auth: { tokenFile: '/tmp/token' },
        limits: { maxBodyBytes: 10_000_000, batchTtlMs: 600_000, idleProjectTimeoutMs: 600_000, projectCap: 100, maxBatchCacheSize: 1000, maxContextBlockBytes: 10_000_000, maxContextBlocksPerProject: 100, shutdownDrainMs: 5_000 },
        autoUpdateSkills: false,
      },
    },
    logger: { emit: () => {} } as any,
    contextBlockStore: { register: () => ({ id: 'test-ctx' }), get: () => ({ content: '' }) } as any,
    batchId: 'test-batch',
    task: { prompt: '' },
    taskIndex: 0,
    cwd: '/tmp/test',
    route: '',
    client: '',
    triggeringSkill: '',
    mainModel: null,
    assignedTier: 'standard',
    implementerProvider: undefined,
    escalationProvider: undefined,
    providers: {},
    implementerIdentity: undefined,
    timing: { startMs: Date.now(), timeoutMs: 0, deadlineMs: 0, stallTimeoutMs: 0 },
    budgets: { maxCostUSD: undefined },
    stall: { controller: new AbortController(), lastEventAtMs: Date.now(), fired: false },
    implementerToolMode: undefined,
    bus: undefined,
    heartbeat: undefined,
    verboseStream: () => {},
    verbose: false,
    outputTargets: [],
    ...overrides,
  } as ExecutionContext;
}

const injectDefaults = (ts: any[]) => ts.map((t) => ({ ...t, tools: 'full' as const, timeoutMs: 600_000, cwd: '/tmp/test' }));

const runTasksOverride = async () => [{
  output: 'hello world',
  status: 'ok' as const,
  usage: { inputTokens: 10, outputTokens: 20, totalTokens: 30, costUSD: 0.001, costDeltaVsParentUSD: null, cachedTokens: null, reasoningTokens: null },
  turns: 1,
  filesRead: [],
  filesWritten: [],
  toolCalls: [],
  outputIsDiagnostic: false,
  escalationLog: [],
  durationMs: 0,
}];

// ---------------------------------------------------------------------------
// executeDelegate — basic path
// ---------------------------------------------------------------------------

describe('executeDelegate', () => {
  it('returns results as concrete values (no clarification gate)', async () => {
    const result = await executeDelegate(
      makeCtx(),
      { tasks: [{ prompt: 'Write a hello world function in TypeScript' }] },
      { injectDefaults, runTasksOverride },
    );

    expect(Array.isArray(result.results)).toBe(true);
    expect(result.batchId).toBe('test-batch-id');
  });
});
