import { executePlanInputSchema } from '../../packages/core/src/tools/execute-plan/tool-config.js';
import { toolConfig as executePlanConfig } from '../../packages/core/src/tools/execute-plan/tool-config.js';

describe('dispatch mode config + schema', () => {
  it('execute-plan config is serial and not overridable', () => {
    expect(executePlanConfig.dispatchMode).toBe('serial');
    expect(executePlanConfig.dispatchModeOverridable).toBe(false);
  });

  it('execute-plan schema rejects an execution field (strict)', () => {
    const r = executePlanInputSchema.safeParse({ filePaths: ['/p/plan.md'], execution: 'serial' });
    expect(r.success).toBe(false);
  });
});

import { vi } from 'vitest';

vi.mock('../../packages/core/src/lifecycle/task-runner.js', () => ({
  runTaskViaDispatcher: vi.fn(),
  applyParallelSafetySuffixIfNeeded: (tasks: any[], concurrent: boolean) =>
    concurrent ? tasks.map((t) => ({ ...t, prompt: t.prompt + ' [SUFFIX]' })) : tasks.slice(),
}));

// Stub the resolver so resolveAgent never throws (no real provider config in test).
vi.mock('../../packages/core/src/providers/agent-resolver.js', () => ({
  resolveAgent: () => ({ slot: 'standard', provider: { name: 'stub', config: { type: 'claude', model: 'stub' } } }),
}));

import { runTaskViaDispatcher } from '../../packages/core/src/lifecycle/task-runner.js';
import { executeTask } from '../../packages/core/src/lifecycle/task-executor.js';

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
    (runTaskViaDispatcher as any).mockImplementation(async () => {
      active++; maxActive = Math.max(maxActive, active);
      await new Promise((r) => setTimeout(r, 5)); active--;
      return okResult(0);
    });
    const out = await executeTask(configStub('parallel', true), ctxStub(),
      { tasks: [{ prompt: 'a' }, { prompt: 'b' }, { prompt: 'c' }] } as any);
    expect(maxActive).toBe(3);
    expect(out.dispatchMode).toBe('parallel');
  });

  it('serial: runs one at a time', async () => {
    let active = 0; let maxActive = 0;
    (runTaskViaDispatcher as any).mockImplementation(async () => {
      active++; maxActive = Math.max(maxActive, active);
      await new Promise((r) => setTimeout(r, 5)); active--;
      return okResult(0);
    });
    const out = await executeTask(configStub('serial', false), ctxStub(),
      { tasks: [{ prompt: 'a' }, { prompt: 'b' }] } as any);
    expect(maxActive).toBe(1);
    expect(out.dispatchMode).toBe('serial');
  });

  it('delegate-style override: execution:serial forces serial when overridable', async () => {
    let maxActive = 0; let active = 0;
    (runTaskViaDispatcher as any).mockImplementation(async () => {
      active++; maxActive = Math.max(maxActive, active);
      await new Promise((r) => setTimeout(r, 5)); active--;
      return okResult(0);
    });
    const out = await executeTask(configStub('parallel', true), ctxStub(),
      { tasks: [{ prompt: 'a' }, { prompt: 'b' }], execution: 'serial' } as any);
    expect(maxActive).toBe(1);
    expect(out.dispatchMode).toBe('serial');
  });

  it('non-overridable route ignores execution field', async () => {
    let maxActive = 0; let active = 0;
    (runTaskViaDispatcher as any).mockImplementation(async () => {
      active++; maxActive = Math.max(maxActive, active);
      await new Promise((r) => setTimeout(r, 5)); active--;
      return okResult(0);
    });
    const out = await executeTask(configStub('serial', false), ctxStub(),
      { tasks: [{ prompt: 'a' }, { prompt: 'b' }], execution: 'parallel' } as any);
    expect(maxActive).toBe(1);
    expect(out.dispatchMode).toBe('serial');
  });
});
