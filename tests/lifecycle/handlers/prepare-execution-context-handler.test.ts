import { describe, it, expect } from 'vitest';
import * as os from 'node:os';
import { prepareExecutionContextHandler } from '../../../packages/core/src/lifecycle/handlers/prepare-execution-context-handler.js';
import type { LifecycleState } from '../../../packages/core/src/lifecycle/stage-plan-types.js';
import type { ExecutionContext } from '../../../packages/core/src/lifecycle/lifecycle-context.js';
import type { TaskSpec } from '../../../packages/core/src/types.js';

function makeState(overrides: Partial<LifecycleState> = {}): LifecycleState {
  return {
    terminal: false,
    attemptIndex: 0,
    attemptBudget: 1,
    reviewPolicy: 'full',
    shutdownInProgress: false,
    ...overrides,
  };
}

function makeCtx(): ExecutionContext {
  return {
    task: { prompt: 'x' } as TaskSpec,
    taskIndex: 0,
    config: {} as ExecutionContext['config'],
    cwd: os.tmpdir(),
    route: 'delegate',
    client: 'test',
    mainModel: null,
    assignedTier: 'standard',
    implementerProvider: {} as ExecutionContext['implementerProvider'],
    escalationProvider: undefined,
    providers: {},
    implementerIdentity: undefined,
    timing: { startMs: Date.now(), timeoutMs: 60_000, deadlineMs: Date.now() + 60_000, stallTimeoutMs: 60_000 },
    stall: { controller: new AbortController(), lastEventAtMs: Date.now(), fired: false },
    implementerToolMode: 'full',
    bus: undefined,
    heartbeat: undefined,
    logger: undefined,
    verboseStream: () => {},
    verbose: false,
    outputTargets: [],
  };
}

describe('prepareExecutionContextHandler', () => {
  it('idempotency: leaves slots untouched when both task and executionContext are populated', () => {
    const task = { prompt: 'pre-populated' } as TaskSpec;
    const ctx = makeCtx();
    const state = makeState({ task, executionContext: ctx });
    prepareExecutionContextHandler(state);
    expect(state.task).toBe(task);
    expect(state.executionContext).toBe(ctx);
  });

  it('surfaces the first TaskSpec from rawRequest.tasks when state.task is empty', () => {
    const t1 = { prompt: 'first' } as TaskSpec;
    const t2 = { prompt: 'second' } as TaskSpec;
    const state = makeState({ request: { tasks: [t1, t2] } });
    prepareExecutionContextHandler(state);
    expect(state.task).toBe(t1);
  });

  it('does not synthesize executionContext (callers must supply it)', () => {
    const t1 = { prompt: 'first' } as TaskSpec;
    const state = makeState({ request: { tasks: [t1] } });
    prepareExecutionContextHandler(state);
    expect(state.executionContext).toBeUndefined();
  });

  it('no-ops when rawRequest has no tasks array', () => {
    const state = makeState({ request: { other: 'shape' } });
    prepareExecutionContextHandler(state);
    expect(state.task).toBeUndefined();
  });

  it('no-ops when rawRequest is undefined', () => {
    const state = makeState();
    prepareExecutionContextHandler(state);
    expect(state.task).toBeUndefined();
  });

  it('honors pre-populated task even when rawRequest carries a different task[0]', () => {
    const preTask = { prompt: 'pre' } as TaskSpec;
    const reqTask = { prompt: 'request' } as TaskSpec;
    const ctx = makeCtx();
    const state = makeState({ task: preTask, executionContext: ctx, request: { tasks: [reqTask] } });
    prepareExecutionContextHandler(state);
    expect(state.task).toBe(preTask);
  });
});
