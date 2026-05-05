import { describe, it, expect } from 'vitest';
import { executeDelegate } from '../../packages/core/src/lifecycle/executors/delegate.js';
import { buildExecutionContext } from '../../packages/core/src/lifecycle/executors/execution-context.js';
import type { ExecutionContext } from '../../packages/core/src/lifecycle/executors/types.js';
import type { ProjectContext } from '../../packages/core/src/project-context.js';
import { isNotApplicable } from '../../packages/core/src/reporting/not-applicable.js';

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

  return buildExecutionContext({
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
    ...overrides,
  });
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
  it('returns proposedInterpretation as notApplicable (no clarification gate)', async () => {
    const result = await executeDelegate(
      makeCtx(),
      { tasks: [{ prompt: 'Write a hello world function in TypeScript' }] },
      { injectDefaults, runTasksOverride },
    );

    expect(isNotApplicable(result.proposedInterpretation)).toBe(true);
    if (isNotApplicable(result.proposedInterpretation)) {
      expect(result.proposedInterpretation.reason).toBe('batch not awaiting clarification');
    }
  });

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
