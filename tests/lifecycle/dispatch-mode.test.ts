import { inputSchema as delegateSchema } from '../../packages/core/src/tools/delegate/schema.js';
import { executePlanInputSchema } from '../../packages/core/src/tools/execute-plan/tool-config.js';
import { toolConfig as delegateConfig } from '../../packages/core/src/tools/delegate/tool-config.js';
import { toolConfig as executePlanConfig } from '../../packages/core/src/tools/execute-plan/tool-config.js';

describe('dispatch mode config + schema', () => {
  it('delegate config defaults to parallel and is caller-overridable', () => {
    expect(delegateConfig.dispatchMode).toBe('parallel');
    expect(delegateConfig.dispatchModeOverridable).toBe(true);
  });

  it('execute-plan config is serial and not overridable', () => {
    expect(executePlanConfig.dispatchMode).toBe('serial');
    expect(executePlanConfig.dispatchModeOverridable).toBe(false);
  });

  it('delegate schema accepts an execution override', () => {
    const r = delegateSchema.safeParse({ tasks: [{ prompt: 'x' }], execution: 'serial' });
    expect(r.success).toBe(true);
  });

  it('delegate schema rejects an unknown execution value', () => {
    const r = delegateSchema.safeParse({ tasks: [{ prompt: 'x' }], execution: 'bogus' });
    expect(r.success).toBe(false);
  });

  it('execute-plan schema rejects an execution field (strict)', () => {
    const r = executePlanInputSchema.safeParse({ filePaths: ['/p/plan.md'], execution: 'serial' });
    expect(r.success).toBe(false);
  });
});

import { vi } from 'bun:test';
import { executeTask } from '../../packages/core/src/lifecycle/task-executor.js';

// Inject dispatcher + resolver via executeTask's deps param instead of vi.mock
// — under Bun mock.module is sticky/process-global and leaked into later tests.
const mockDispatch = vi.fn();
const execDeps = {
  runTaskViaDispatcher: mockDispatch,
  applyParallelSafetySuffixIfNeeded: (tasks: any[], concurrent: boolean) =>
    concurrent ? tasks.map((t: any) => ({ ...t, prompt: t.prompt + ' [SUFFIX]' })) : tasks.slice(),
  resolveAgent: () => ({ slot: 'standard', provider: { name: 'stub', config: { type: 'claude', model: 'stub' } } }),
} as any;
const runExec = (config: any, ctx: any, input: any) => executeTask(config, ctx, input, execDeps);

const okResult = (i: number) => ({
  output: '', status: 'ok', usage: { inputTokens: 0, outputTokens: 0, cachedReadTokens: 0, cachedNonReadTokens: 0 },
  turns: 0, filesWritten: [], outputIsDiagnostic: false, escalationLog: [], durationMs: 1,
  workerStatus: 'done', actualCostUSD: 0, directoriesListed: [], _i: i,
});

function ctxStub(): any {
  // resolveAgent is mocked above, so config can be minimal.
  return {
    config: { agents: {}, defaults: { tools: 'full', timeoutMs: 60_000 } },
    cwd: '/tmp/x',
    mainModel: 'claude-opus-4-7',
    stall: { controller: new AbortController() },
  };
}

function configStub(mode: 'serial' | 'parallel', overridable: boolean): any {
  return {
    name: 'test', category: 'artifact_producing', agentType: 'standard',
    dispatchMode: mode, dispatchModeOverridable: overridable,
    briefSlot: (input: any) => input.tasks,
    buildTaskSpec: (brief: any) => ({ prompt: brief.prompt, cwd: '/tmp/x', agentType: 'standard' }),
    reportSchema: { parse: () => ({}) },
    headlineTemplate: { compose: () => 'h' },
  };
}

describe('scheduler mode', () => {
  beforeEach(() => vi.clearAllMocks());

  it('parallel: launches all dispatchOne calls before any resolves', async () => {
    let active = 0; let maxActive = 0;
    mockDispatch.mockImplementation(async () => {
      active++; maxActive = Math.max(maxActive, active);
      await new Promise((r) => setTimeout(r, 5)); active--;
      return okResult(0);
    });
    const out = await runExec(configStub('parallel', true), ctxStub(),
      { tasks: [{ prompt: 'a' }, { prompt: 'b' }, { prompt: 'c' }] } as any);
    expect(maxActive).toBe(3);
    expect(out.dispatchMode).toBe('parallel');
  });

  it('serial: runs one at a time', async () => {
    let active = 0; let maxActive = 0;
    mockDispatch.mockImplementation(async () => {
      active++; maxActive = Math.max(maxActive, active);
      await new Promise((r) => setTimeout(r, 5)); active--;
      return okResult(0);
    });
    const out = await runExec(configStub('serial', false), ctxStub(),
      { tasks: [{ prompt: 'a' }, { prompt: 'b' }] } as any);
    expect(maxActive).toBe(1);
    expect(out.dispatchMode).toBe('serial');
  });

  it('delegate-style override: execution:serial forces serial when overridable', async () => {
    let maxActive = 0; let active = 0;
    mockDispatch.mockImplementation(async () => {
      active++; maxActive = Math.max(maxActive, active);
      await new Promise((r) => setTimeout(r, 5)); active--;
      return okResult(0);
    });
    const out = await runExec(configStub('parallel', true), ctxStub(),
      { tasks: [{ prompt: 'a' }, { prompt: 'b' }], execution: 'serial' } as any);
    expect(maxActive).toBe(1);
    expect(out.dispatchMode).toBe('serial');
  });

  it('non-overridable route ignores execution field', async () => {
    let maxActive = 0; let active = 0;
    mockDispatch.mockImplementation(async () => {
      active++; maxActive = Math.max(maxActive, active);
      await new Promise((r) => setTimeout(r, 5)); active--;
      return okResult(0);
    });
    const out = await runExec(configStub('serial', false), ctxStub(),
      { tasks: [{ prompt: 'a' }, { prompt: 'b' }], execution: 'parallel' } as any);
    expect(maxActive).toBe(1);
    expect(out.dispatchMode).toBe('serial');
  });
});
