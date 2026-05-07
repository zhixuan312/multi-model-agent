import { describe, it, expect } from 'vitest';
import * as os from 'node:os';
import { runVerifyCommandHandler } from '../../../packages/core/src/lifecycle/handlers/run-verify-command-handler.js';
import type { LifecycleState } from '../../../packages/core/src/lifecycle/stage-plan-types.js';
import type { ExecutionContext } from '../../../packages/core/src/lifecycle/lifecycle-context.js';
import type { VerifyStageResult } from '../../../packages/core/src/lifecycle/handlers/verify-stage.js';
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

function makeCtx(overrides: Partial<ExecutionContext> = {}): ExecutionContext {
  const base = {
    task: { prompt: 'x', tools: 'full', timeoutMs: 60_000 } as TaskSpec,
    taskIndex: 0,
    config: {} as ExecutionContext['config'],
    cwd: os.tmpdir(),
    route: 'delegate',
    client: 'test',
    triggeringSkill: '',
    mainModel: null,
    assignedTier: 'standard' as const,
    implementerProvider: {} as ExecutionContext['implementerProvider'],
    escalationProvider: undefined,
    providers: {},
    implementerIdentity: undefined,
    timing: { startMs: Date.now(), timeoutMs: 60_000, deadlineMs: Date.now() + 60_000, stallTimeoutMs: 60_000 },
    budgets: { maxCostUSD: undefined },
    stall: { controller: new AbortController(), lastEventAtMs: Date.now(), fired: false },
    implementerToolMode: 'full' as const,
    bus: undefined,
    heartbeat: undefined,
    logger: undefined,
    verboseStream: () => {},
    verbose: false,
    outputTargets: [],
  };
  return { ...base, ...overrides };
}

describe('runVerifyCommandHandler', () => {
  it('skips when state.verifyResult is already set (idempotency)', async () => {
    const prior: VerifyStageResult = { status: 'passed', steps: [], totalDurationMs: 0 };
    const state = makeState({ verifyResult: prior });
    await runVerifyCommandHandler(state);
    expect(state.verifyResult).toBe(prior);
  });

  it('no-ops when state.task is undefined (data flow not ready)', async () => {
    const state = makeState({ executionContext: makeCtx({ task: undefined as unknown as TaskSpec }) });
    await runVerifyCommandHandler(state);
    expect(state.verifyResult).toBeUndefined();
  });

  it('no-ops when state.executionContext is undefined', async () => {
    const state = makeState({ task: { prompt: 'x', verifyCommand: ['true'] } as TaskSpec });
    await runVerifyCommandHandler(state);
    expect(state.verifyResult).toBeUndefined();
  });

  it('emits verify_skipped via bus when verifyCommand is undefined', async () => {
    const events: Array<Record<string, unknown>> = [];
    const bus = { emit: (e: Record<string, unknown>) => { events.push(e); } } as unknown as ExecutionContext['bus'];
    const ctx = makeCtx({ bus, task: { prompt: 'x' } as TaskSpec });
    const state = makeState({ task: ctx.task, executionContext: ctx });
    await runVerifyCommandHandler(state);
    expect(state.verifyResult).toBeDefined();
    expect(state.verifyResult?.status).toBe('skipped');
    const skipEvents = events.filter((e) => e.event === 'verify_skipped');
    expect(skipEvents.length).toBe(1);
    expect(skipEvents[0].reason).toBe('no_command');
  });

  it('runs verify command when present and writes verifyResult', async () => {
    const events: Array<Record<string, unknown>> = [];
    const bus = { emit: (e: Record<string, unknown>) => { events.push(e); } } as unknown as ExecutionContext['bus'];
    const task: TaskSpec = { prompt: 'x', verifyCommand: ['echo ok'] } as TaskSpec;
    const ctx = makeCtx({ bus, task });
    const state = makeState({ task, executionContext: ctx });
    await runVerifyCommandHandler(state);
    expect(state.verifyResult).toBeDefined();
    expect(state.verifyResult?.steps).toHaveLength(1);
    expect(state.verifyResult?.steps[0].status).toBe('passed');
    const stepEvents = events.filter((e) => e.event === 'verify_step');
    expect(stepEvents.length).toBe(1);
  });
});
