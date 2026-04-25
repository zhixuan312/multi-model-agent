import { describe, it, expect } from 'vitest';
import type { RunResult } from '../../packages/core/src/types.js';
import { executeDelegate } from '../../packages/core/src/executors/delegate.js';
import { buildExecutionContext } from '../../packages/core/src/executors/execution-context.js';
import type { ExecutionContext } from '../../packages/core/src/executors/types.js';
import type { ProjectContext } from '../../packages/core/src/project-context.js';

function makeCtx(overrides?: Partial<ExecutionContext>): ExecutionContext {
  const pc = {
    cwd: '/tmp/test',
    batchCache: {
      remember: () => 'test-batch-id',
      abort: () => {},
      complete: () => {},
    },
    clarifications: { create: () => undefined },
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
        limits: { maxBodyBytes: 10_000_000, batchTtlMs: 600_000, idleProjectTimeoutMs: 600_000, clarificationTimeoutMs: 600_000, projectCap: 100, maxBatchCacheSize: 1000, maxContextBlockBytes: 10_000_000, maxContextBlocksPerProject: 100, shutdownDrainMs: 5_000 },
        autoUpdateSkills: false,
      },
    },
    logger: { emit: () => {} } as any,
    contextBlockStore: { register: () => ({ id: 'test-ctx' }), get: () => ({ content: '' }) } as any,
    batchId: 'test-batch',
    ...overrides,
  });
}

describe('Executor surfaces structured executor_error code', () => {
  it('sets structuredError.code = "executor_error" on RunResult when runTasks throws', async () => {
    const throwingRunTasks = async () => {
      throw new Error('simulated executor bug');
    };

    const result = await executeDelegate(
      makeCtx(),
      { tasks: [{ prompt: 'test task' }] },
      {
        injectDefaults: (ts) => ts.map((t) => ({ ...t, tools: 'full' as const, timeoutMs: 600_000, cwd: '/tmp/test' })),
        runTasksOverride: throwingRunTasks as any,
      },
    );

    expect(result.error).not.toEqual(expect.objectContaining({ code: 'not_applicable' }));
    const runResults = result.results;
    expect(Array.isArray(runResults)).toBe(true);
    if (Array.isArray(runResults)) {
      expect(runResults.length).toBeGreaterThan(0);
      for (const r of runResults) {
        expect(r.structuredError?.code).toBe('executor_error');
        expect(r.structuredError?.where).toBe('executor:delegate');
        expect(r.structuredError?.message).toContain('simulated executor bug');
        expect(r.errorCode).toBe('executor_error');
        expect(r.workerStatus).toBe('failed');
      }
    }
  });

  it('accepts executor_error as a valid structuredError code at the type level', () => {
    const r: RunResult = {
      output: '',
      status: 'error',
      usage: { inputTokens: 0, outputTokens: 0, totalTokens: 0, costUSD: null },
      turns: 0,
      filesRead: [],
      filesWritten: [],
      toolCalls: [],
      outputIsDiagnostic: false,
      escalationLog: [],
      structuredError: {
        code: 'executor_error',
        message: 'test error',
        where: 'executor:test',
      },
    };
    expect(r.structuredError?.code).toBe('executor_error');
    expect(r.structuredError?.where).toBe('executor:test');
  });
});
