import { describe, it, expect, vi } from 'vitest';
import { terminalHandler } from '../../packages/core/src/lifecycle/handlers/terminal-handlers.js';
import { InMemoryContextBlockStore } from '../../packages/core/src/stores/context-block-tool.js';
import { TaskEnvelopeStore } from '../../packages/core/src/events/task-envelope.js';

function makeRegistry() {
  const blocks = new Map<string, string>();
  return {
    recordTerminalBlock(batchId: string, taskIndex: number, blockId: string) {
      blocks.set(`${batchId}:${taskIndex}`, blockId);
    },
    getTerminalBlock(batchId: string, taskIndex: number): string | undefined {
      return blocks.get(`${batchId}:${taskIndex}`);
    },
    // Satisfy BatchRegistryLike for persistToBatchRegistryHandler
    complete() {},
  };
}

function makeState(route: 'review' | 'execute-plan') {
  const store = new InMemoryContextBlockStore();
  const registry = makeRegistry();
  const envelope = TaskEnvelopeStore.create({
    taskId: 't0', batchId: 'b1', taskIndex: 0, route, agentType: 'complex',
    client: 'claude-code', mainModel: 'claude-opus-4-7', cwd: '/tmp', reviewPolicy: 'none',
  });
  envelope.recordFinding({ id: 'F1', severity: 'high', category: 'x', claim: 'c', evidence: 'e', suggestion: 's', source: 'implementer' } as any);
  const state: any = {
    route,
    executionContext: { envelope, contextBlockStore: store, batchRegistry: registry },
    lastRunResult: { output: 'done', workerStatus: 'done' },
    gates: { implement: { outcome: 'advance', payload: { workerSelfAssessment: 'done' } } },
  };
  return { state, store, registry, envelope };
}

describe('terminal context block registration', () => {
  it('read route (review): registers a block and seals its id', async () => {
    const { state, store, registry, envelope } = makeState('review');
    await terminalHandler(state);
    expect(state.contextBlockId).toBe('terminal-b1-0');
    expect(store.get('terminal-b1-0')).toBeTruthy();
    expect(registry.getTerminalBlock('b1', 0)).toBe('terminal-b1-0');
    expect(envelope.snapshot().contextBlockId).toBe('terminal-b1-0');
  });

  it('write route (execute-plan): registers nothing, contextBlockId null', async () => {
    const { state, store, envelope } = makeState('execute-plan');
    await terminalHandler(state);
    expect(state.contextBlockId).toBeUndefined();
    expect(store.size).toBe(0);
    expect(envelope.snapshot().contextBlockId).toBeNull();
  });

  it('re-invocation is idempotent: stable id, no second block', async () => {
    const { state, store } = makeState('review');
    await terminalHandler(state);
    const first = state.contextBlockId;
    await terminalHandler(state);
    expect(state.contextBlockId).toBe(first);
    expect(store.size).toBe(1);
  });

  it('best-effort: store.register failure leaves contextBlockId null + seal still runs', async () => {
    const { state, envelope } = makeState('review');
    state.executionContext.contextBlockStore = {
      register: vi.fn(() => { throw new Error('boom'); }),
      get: () => undefined, delete: () => false, pin: () => {}, unpin: () => {},
      refcount: () => 0, clear: () => {}, runIdleSweep: () => 0, size: 0, ttlMs: 0,
    };
    await terminalHandler(state);
    expect(state.contextBlockId).toBeUndefined();
    expect(envelope.isSealed()).toBe(true);
    expect(envelope.snapshot().contextBlockId).toBeNull();
    expect(envelope.snapshot().validationWarnings.some((w: any) => w.rule === 'TerminalBlockRegisterFailed')).toBe(true);
  });
});
