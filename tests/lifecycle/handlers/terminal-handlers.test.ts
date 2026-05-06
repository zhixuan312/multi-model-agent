import { describe, it, expect } from 'vitest';
import * as os from 'node:os';
import {
  registerTerminalBlockHandler,
  emitTaskTerminalHandler,
  persistToBatchRegistryHandler,
  flushTelemetryHandler,
} from '../../../packages/core/src/lifecycle/handlers/terminal-handlers.js';
import type { LifecycleState } from '../../../packages/core/src/lifecycle/stage-plan-types.js';
import type { ExecutionContext } from '../../../packages/core/src/lifecycle/lifecycle-context.js';
import type { RunResult, TaskSpec } from '../../../packages/core/src/types.js';

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
  return {
    task: { prompt: 'x' } as TaskSpec,
    taskIndex: 0,
    config: {} as ExecutionContext['config'],
    cwd: os.tmpdir(),
    route: 'delegate',
    client: 'test',
    triggeringSkill: '',
    mainModel: null,
    assignedTier: 'standard',
    implementerProvider: {} as ExecutionContext['implementerProvider'],
    escalationProvider: undefined,
    providers: {},
    implementerIdentity: undefined,
    timing: { startMs: Date.now(), timeoutMs: 60_000, deadlineMs: Date.now() + 60_000, stallTimeoutMs: 60_000 },
    budgets: { maxCostUSD: undefined },
    stall: { controller: new AbortController(), lastEventAtMs: Date.now(), fired: false },
    implementerToolMode: 'full',
    bus: undefined,
    heartbeat: undefined,
    logger: undefined,
    verboseStream: () => {},
    verbose: false,
    outputTargets: [],
    ...overrides,
  };
}

const fakeRunResult: RunResult = {
  output: 'hello',
  status: 'ok',
  usage: { inputTokens: 0, outputTokens: 0 },
  turns: 0,
  filesRead: [],
  filesWritten: [],
  toolCalls: [],
  outputIsDiagnostic: false,
  escalationLog: [],
  parsedFindings: null,
  workerStatus: 'done',
} as RunResult;

describe('registerTerminalBlockHandler', () => {
  it('idempotency: skips when terminalBlockId already set', () => {
    const state = makeState({ terminalBlockId: 'preset' });
    registerTerminalBlockHandler(state);
    expect(state.terminalBlockId).toBe('preset');
  });

  it('no-ops when executionContext missing', () => {
    const state = makeState({ lastRunResult: fakeRunResult });
    registerTerminalBlockHandler(state);
    expect(state.terminalBlockId).toBeUndefined();
  });

  it('no-ops when lastRunResult missing', () => {
    const state = makeState({ executionContext: makeCtx() });
    registerTerminalBlockHandler(state);
    expect(state.terminalBlockId).toBeUndefined();
  });

  it('writes terminalBlockId and calls store.register when present', () => {
    const calls: Array<{ id: string; content: string }> = [];
    const ctx = makeCtx() as ExecutionContext & { contextBlockStore?: { register?: (p: { id: string; content: string }) => void } };
    ctx.contextBlockStore = { register: (p) => { calls.push(p); } };
    const state = makeState({ executionContext: ctx, lastRunResult: fakeRunResult });
    registerTerminalBlockHandler(state);
    expect(state.terminalBlockId).toMatch(/^terminal-/);
    expect(calls).toHaveLength(1);
    expect(calls[0].content).toBe('hello');
  });

  it('survives store.register throwing (advisory)', () => {
    const ctx = makeCtx() as ExecutionContext & { contextBlockStore?: { register?: (p: { id: string; content: string }) => void } };
    ctx.contextBlockStore = { register: () => { throw new Error('fail'); } };
    const state = makeState({ executionContext: ctx, lastRunResult: fakeRunResult });
    expect(() => registerTerminalBlockHandler(state)).not.toThrow();
    expect(state.terminalBlockId).toMatch(/^terminal-/);
  });
});

describe('emitTaskTerminalHandler', () => {
  it('idempotency: skips when taskTerminalEmitted already true', () => {
    const events: Array<Record<string, unknown>> = [];
    const bus = { emit: (e: Record<string, unknown>) => { events.push(e); } } as unknown as ExecutionContext['bus'];
    const state = makeState({ executionContext: makeCtx({ bus }), taskTerminalEmitted: true });
    emitTaskTerminalHandler(state);
    expect(events).toHaveLength(0);
  });

  it('no-ops when executionContext missing', () => {
    const state = makeState();
    emitTaskTerminalHandler(state);
    expect(state.taskTerminalEmitted).toBeUndefined();
  });

  it('marks emitted but skips bus when bus is absent', () => {
    const state = makeState({ executionContext: makeCtx({ bus: undefined }) });
    emitTaskTerminalHandler(state);
    expect(state.taskTerminalEmitted).toBe(true);
  });

  it('emits task_done_summary with chain pass slots', () => {
    const events: Array<Record<string, unknown>> = [];
    const bus = { emit: (e: Record<string, unknown>) => { events.push(e); } } as unknown as ExecutionContext['bus'];
    const state = makeState({
      executionContext: makeCtx({ bus }),
      lastRunResult: fakeRunResult,
      route: 'delegate',
      specChainPassed: true,
      qualityChainPassed: true,
      diffReviewVerdict: 'approved',
      terminalBlockId: 'terminal-abc',
    });
    emitTaskTerminalHandler(state);
    expect(events).toHaveLength(1);
    expect(events[0].event).toBe('task_done_summary');
    expect(events[0].route).toBe('delegate');
    expect(events[0].workerStatus).toBe('done');
    expect(events[0].specChainPassed).toBe(true);
    expect(events[0].qualityChainPassed).toBe(true);
    expect(events[0].diffReviewVerdict).toBe('approved');
    expect(events[0].terminalBlockId).toBe('terminal-abc');
    expect(state.taskTerminalEmitted).toBe(true);
  });
});

describe('persistToBatchRegistryHandler', () => {
  it('idempotency: skips when batchRegistryPersisted already true', () => {
    const ctx = makeCtx() as ExecutionContext & { batchRegistry?: { complete?: (i: number, r: unknown) => void } };
    let called = false;
    ctx.batchRegistry = { complete: () => { called = true; } };
    const state = makeState({ executionContext: ctx, batchRegistryPersisted: true });
    persistToBatchRegistryHandler(state);
    expect(called).toBe(false);
  });

  it('no-ops when executionContext missing', () => {
    const state = makeState();
    persistToBatchRegistryHandler(state);
    expect(state.batchRegistryPersisted).toBeUndefined();
  });

  it('marks persisted as structural ack when registry absent', () => {
    const state = makeState({ executionContext: makeCtx() });
    persistToBatchRegistryHandler(state);
    expect(state.batchRegistryPersisted).toBe(true);
  });

  it('calls registry.complete with taskIndex and lastRunResult', () => {
    const calls: Array<{ taskIndex: number; result: unknown }> = [];
    const ctx = makeCtx({ taskIndex: 7 }) as ExecutionContext & { batchRegistry?: { complete?: (i: number, r: unknown) => void } };
    ctx.batchRegistry = { complete: (taskIndex, result) => { calls.push({ taskIndex, result }); } };
    const state = makeState({ executionContext: ctx, lastRunResult: fakeRunResult });
    persistToBatchRegistryHandler(state);
    expect(calls).toHaveLength(1);
    expect(calls[0].taskIndex).toBe(7);
    expect(calls[0].result).toBe(fakeRunResult);
    expect(state.batchRegistryPersisted).toBe(true);
  });
});

describe('flushTelemetryHandler', () => {
  it('idempotency: skips when telemetryFlushed already true', async () => {
    let called = false;
    const ctx = makeCtx() as ExecutionContext & { recorder?: { flush?: () => Promise<void> } };
    ctx.recorder = { flush: async () => { called = true; } };
    const state = makeState({ executionContext: ctx, telemetryFlushed: true });
    await flushTelemetryHandler(state);
    expect(called).toBe(false);
  });

  it('no-ops when executionContext missing', async () => {
    const state = makeState();
    await flushTelemetryHandler(state);
    expect(state.telemetryFlushed).toBeUndefined();
  });

  it('marks flushed when recorder absent', async () => {
    const state = makeState({ executionContext: makeCtx() });
    await flushTelemetryHandler(state);
    expect(state.telemetryFlushed).toBe(true);
  });

  it('calls recorder.flush()', async () => {
    let called = false;
    const ctx = makeCtx() as ExecutionContext & { recorder?: { flush?: () => Promise<void> } };
    ctx.recorder = { flush: async () => { called = true; } };
    const state = makeState({ executionContext: ctx });
    await flushTelemetryHandler(state);
    expect(called).toBe(true);
    expect(state.telemetryFlushed).toBe(true);
  });

  it('survives recorder.flush throwing', async () => {
    const ctx = makeCtx() as ExecutionContext & { recorder?: { flush?: () => Promise<void> } };
    ctx.recorder = { flush: async () => { throw new Error('fail'); } };
    const state = makeState({ executionContext: ctx });
    await expect(flushTelemetryHandler(state)).resolves.toBeUndefined();
    expect(state.telemetryFlushed).toBe(true);
  });
});
