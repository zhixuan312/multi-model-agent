import { describe, it, expect, vi, beforeEach } from 'bun:test';
import { EnvelopeBus } from '../../packages/core/src/events/envelope-bus.js';
import { TaskEnvelopeStore } from '../../packages/core/src/events/task-envelope.js';
import { BatchRegistry } from '../../packages/core/src/stores/batch-registry.js';

// Mock the per-task dispatcher so the test focuses on envelope attachment
// instead of running real lifecycle stages. Capture each call so we can
// assert that dispatchOne saw a distinct envelope per task.
const capturedEnvelopes: Array<{ taskIndex: number; envelope: TaskEnvelopeStore | undefined }> = [];
const mockRunTask = vi.fn(async (input: {
  taskIndex: number;
  envelope?: TaskEnvelopeStore;
}) => {
  capturedEnvelopes.push({ taskIndex: input.taskIndex, envelope: input.envelope });
  return {
    output: '',
    status: 'ok',
    usage: { inputTokens: 0, outputTokens: 0, cachedReadTokens: 0, cachedNonReadTokens: 0 },
    turns: 0,
    filesWritten: [],
    outputIsDiagnostic: false,
    escalationLog: [],
    durationMs: 1,
    workerStatus: 'done',
    actualCostUSD: 0,
    directoriesListed: [],
  } as any;
});

vi.mock('../../packages/core/src/lifecycle/task-runner.js', () => ({
  runTaskViaDispatcher: (input: any) => mockRunTask(input),
  applyParallelSafetySuffixIfNeeded: (tasks: any[], _concurrent: boolean) => tasks.slice(),
}));

// Stub the agent resolver so resolution doesn't fail when no real config exists.
vi.mock('../../packages/core/src/providers/agent-resolver.js', () => ({
  resolveAgent: () => ({ slot: 'standard', provider: { name: 'stub', config: { type: 'claude', model: 'stub' } } }),
}));

// Use the delegate tool config so briefSlot maps the input tasks 1:1 to
// briefs (exercises the multi-task path naturally).
const toolConfigImport = await import('../../packages/core/src/tools/delegate/tool-config.js');
const { executeTask } = await import('../../packages/core/src/lifecycle/task-executor.js');

function buildContext(batchId: string, bus: EnvelopeBus, registry: BatchRegistry, envelope: TaskEnvelopeStore) {
  return {
    batchId,
    config: { agents: {}, defaults: { tools: 'full', timeoutMs: 60_000 } } as any,
    projectContext: { cwd: '/tmp/test' } as any,
    bus,
    batchRegistry: registry,
    envelope,
    route: 'delegate',
    client: 'test',
    mainModel: 'claude-opus-4-7',
    contextBlockStore: undefined,
    logger: { info: () => {}, warn: () => {}, error: () => {}, log: () => {} },
    // Serial dispatch reads ctx.stall.controller.signal for cooperative
    // cancellation; parallel dispatch ignores it. Either way it must exist.
    stall: { controller: new AbortController() },
  } as any;
}

describe('multi-task /delegate envelope attachment', () => {
  beforeEach(() => {
    capturedEnvelopes.length = 0;
    mockRunTask.mockClear();
  });

  it('single-task input: dispatchOne receives the pre-existing envelope (no new attachment)', async () => {
    const bus = new EnvelopeBus();
    const registry = new BatchRegistry();
    const batchId = 'b-single';
    registry.register({ batchId, projectCwd: '/tmp/test', tool: 'delegate', state: 'pending', startedAt: Date.now(), stateChangedAt: Date.now(), blockIds: [], blocksReleased: false } as any);
    const env0 = TaskEnvelopeStore.create({
      taskId: `${batchId}:0`, batchId, taskIndex: 0,
      route: 'delegate', agentType: 'standard',
      client: 'test', mainModel: 'claude-opus-4-7', cwd: '/tmp/test',
      reviewPolicy: 'full' as const,
    }, bus);
    registry.attachEnvelope(batchId, 0, env0);
    const ctx = buildContext(batchId, bus, registry, env0);

    await executeTask(toolConfigImport.toolConfig, ctx, {
      tasks: [{ prompt: 'task A' }],
    });

    expect(capturedEnvelopes).toHaveLength(1);
    expect(capturedEnvelopes[0]!.envelope).toBe(env0);

    const entry = registry.get(batchId)!;
    expect(entry.taskEnvelopes).toHaveLength(1);
    expect(entry.taskEnvelopes![0]).toBe(env0);
  });

  it('3-task input: produces 3 distinct envelopes (indices 0,1,2) attached to the same batch', async () => {
    const bus = new EnvelopeBus();
    const registry = new BatchRegistry();
    const batchId = 'b-multi';
    registry.register({ batchId, projectCwd: '/tmp/test', tool: 'delegate', state: 'pending', startedAt: Date.now(), stateChangedAt: Date.now(), blockIds: [], blocksReleased: false } as any);
    const env0 = TaskEnvelopeStore.create({
      taskId: `${batchId}:0`, batchId, taskIndex: 0,
      route: 'delegate', agentType: 'standard',
      client: 'test', mainModel: 'claude-opus-4-7', cwd: '/tmp/test',
      reviewPolicy: 'full' as const,
    }, bus);
    registry.attachEnvelope(batchId, 0, env0);
    const ctx = buildContext(batchId, bus, registry, env0);

    await executeTask(toolConfigImport.toolConfig, ctx, {
      tasks: [
        { prompt: 'task A' },
        { prompt: 'task B' },
        { prompt: 'task C' },
      ],
    });

    expect(capturedEnvelopes).toHaveLength(3);
    // Each task received a distinct envelope.
    const e0 = capturedEnvelopes.find(c => c.taskIndex === 0)!.envelope!;
    const e1 = capturedEnvelopes.find(c => c.taskIndex === 1)!.envelope!;
    const e2 = capturedEnvelopes.find(c => c.taskIndex === 2)!.envelope!;
    expect(e0).toBe(env0);
    expect(e1).not.toBe(e0);
    expect(e2).not.toBe(e0);
    expect(e1).not.toBe(e2);

    // The registry has 3 attached envelopes at indices 0,1,2.
    const entry = registry.get(batchId)!;
    expect(entry.taskEnvelopes).toHaveLength(3);
    expect(entry.taskEnvelopes![0]).toBe(env0);
    expect(entry.taskEnvelopes![1]).toBe(e1);
    expect(entry.taskEnvelopes![2]).toBe(e2);

    // Per-task identity carried through: each envelope's taskId is batchId:i.
    expect(e0.snapshot().taskId).toBe(`${batchId}:0`);
    expect(e1.snapshot().taskId).toBe(`${batchId}:1`);
    expect(e2.snapshot().taskId).toBe(`${batchId}:2`);

    // tasksTotal bumped from the async-dispatch placeholder of 1.
    expect(entry.tasksTotal).toBe(3);
    expect(entry.tasksStarted).toBe(3);
  });

  it('3-task input: per-task envelopes can seal independently without SealedEnvelopeError races', async () => {
    const bus = new EnvelopeBus();
    const registry = new BatchRegistry();
    const batchId = 'b-seal';
    registry.register({ batchId, projectCwd: '/tmp/test', tool: 'delegate', state: 'pending', startedAt: Date.now(), stateChangedAt: Date.now(), blockIds: [], blocksReleased: false } as any);
    const env0 = TaskEnvelopeStore.create({
      taskId: `${batchId}:0`, batchId, taskIndex: 0,
      route: 'delegate', agentType: 'standard',
      client: 'test', mainModel: 'claude-opus-4-7', cwd: '/tmp/test',
      reviewPolicy: 'full' as const,
    }, bus);
    registry.attachEnvelope(batchId, 0, env0);
    const ctx = buildContext(batchId, bus, registry, env0);

    await executeTask(toolConfigImport.toolConfig, ctx, {
      tasks: [
        { prompt: 'task A' },
        { prompt: 'task B' },
        { prompt: 'task C' },
      ],
    });

    // Seal each envelope; pre-fix, task 1's recordToolCall on task 0's
    // (already sealed) envelope was the SealedEnvelopeError source. With
    // distinct envelopes this is impossible by construction.
    const entry = registry.get(batchId)!;
    for (const env of entry.taskEnvelopes!) {
      expect(env).not.toBeNull();
      env!.seal({ status: 'done', stopReason: 'normal', realFilesChanged: [] });
      // recordToolCall on the OTHER envelopes should still succeed since
      // each envelope's sealed state is independent.
    }
    expect(entry.taskEnvelopes!.every(e => e!.isSealed())).toBe(true);
  });
});
