// Regression for 4.7.7 wire-honesty: per-task reviewPolicy on /delegate must
// reach the TaskEnvelope (and therefore the wire telemetry record), not be
// silently replaced by async-dispatch's route default of 'full'.
//
// Pre-fix path:
//   1. async-dispatch.ts creates task 0's envelope with reviewPolicy:'full'
//      (no per-task context available yet).
//   2. lifecycle-dispatcher.ts reads `rawRequest.reviewPolicy` from the
//      top-level of the request — but /delegate's schema puts reviewPolicy
//      INSIDE each task, so the read returns undefined and state.reviewPolicy
//      keeps the 'full' default.
//   3. prepare-execution-context-handler corrects state.reviewPolicy from
//      state.task.reviewPolicy for lifecycle gating — but never touches the
//      envelope.
//   4. The envelope's reviewPolicy is sealed at 'full' and emitted on the
//      wire, even though the caller asked for 'none'.
//
// Post-fix: task-executor calls envelope.setReviewPolicy(tasks[0].reviewPolicy)
// once the brief slot has produced TaskSpecs, and seeds tasks 1+'s envelopes
// from tasks[i].reviewPolicy directly.

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { EnvelopeBus } from '../../packages/core/src/events/envelope-bus.js';
import { TaskEnvelopeStore } from '../../packages/core/src/events/task-envelope.js';
import { BatchRegistry } from '../../packages/core/src/stores/batch-registry.js';

// Mock the per-task dispatcher: this test only cares about the envelope's
// reviewPolicy field, not the lifecycle's stage outcomes.
const mockRunTask = vi.fn(async () => ({
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
} as any));

vi.mock('../../packages/core/src/lifecycle/task-runner.js', () => ({
  runTaskViaDispatcher: (input: any) => mockRunTask(input),
}));

vi.mock('../../packages/core/src/providers/agent-resolver.js', () => ({
  resolveAgent: () => ({ slot: 'standard', provider: { name: 'stub', config: { type: 'claude', model: 'stub' } } }),
}));

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
    stall: { controller: new AbortController() },
  } as any;
}

function seedAsyncDispatchEnvelope(batchId: string, bus: EnvelopeBus, registry: BatchRegistry): TaskEnvelopeStore {
  // Mirrors async-dispatch.ts:67 — task 0's envelope is born with the route
  // default before per-task TaskSpecs exist. The fix has to upgrade it later.
  registry.register({
    batchId, projectCwd: '/tmp/test', tool: 'delegate', state: 'pending',
    startedAt: Date.now(), stateChangedAt: Date.now(), blockIds: [], blocksReleased: false,
  } as any);
  const env0 = TaskEnvelopeStore.create({
    taskId: `${batchId}:0`, batchId, taskIndex: 0,
    route: 'delegate', agentType: 'standard',
    client: 'test', mainModel: 'claude-opus-4-7', cwd: '/tmp/test',
    reviewPolicy: 'full' as const,
  }, bus);
  registry.attachEnvelope(batchId, 0, env0);
  return env0;
}

describe('per-task reviewPolicy reaches the envelope (4.7.7 wire-honesty regression guard)', () => {
  beforeEach(() => { mockRunTask.mockClear(); });

  it('single-task /delegate with reviewPolicy=none → envelope.reviewPolicy=none', async () => {
    const bus = new EnvelopeBus();
    const registry = new BatchRegistry();
    const env0 = seedAsyncDispatchEnvelope('b-single-none', bus, registry);
    // Sanity: pre-fix state — envelope was seeded with 'full'.
    expect(env0.snapshot().reviewPolicy).toBe('full');

    await executeTask(toolConfigImport.toolConfig, buildContext('b-single-none', bus, registry, env0), {
      tasks: [{ prompt: 'task A', reviewPolicy: 'none' }],
    });

    // Post-fix: per-task value from the request reaches the envelope.
    expect(env0.snapshot().reviewPolicy).toBe('none');
  });

  it('single-task /delegate with reviewPolicy=quality_only → envelope.reviewPolicy=quality_only', async () => {
    const bus = new EnvelopeBus();
    const registry = new BatchRegistry();
    const env0 = seedAsyncDispatchEnvelope('b-single-quality', bus, registry);

    await executeTask(toolConfigImport.toolConfig, buildContext('b-single-quality', bus, registry, env0), {
      tasks: [{ prompt: 'task A', reviewPolicy: 'quality_only' }],
    });

    expect(env0.snapshot().reviewPolicy).toBe('quality_only');
  });

  it('single-task /delegate with reviewPolicy omitted → envelope keeps schema default full', async () => {
    const bus = new EnvelopeBus();
    const registry = new BatchRegistry();
    const env0 = seedAsyncDispatchEnvelope('b-single-default', bus, registry);

    await executeTask(toolConfigImport.toolConfig, buildContext('b-single-default', bus, registry, env0), {
      tasks: [{ prompt: 'task A' }],
    });

    // Delegate's task schema defaults reviewPolicy to 'full' when omitted.
    expect(env0.snapshot().reviewPolicy).toBe('full');
  });

  it('multi-task /delegate: each envelope gets its own per-task reviewPolicy', async () => {
    const bus = new EnvelopeBus();
    const registry = new BatchRegistry();
    const env0 = seedAsyncDispatchEnvelope('b-multi-mixed', bus, registry);

    await executeTask(toolConfigImport.toolConfig, buildContext('b-multi-mixed', bus, registry, env0), {
      tasks: [
        { prompt: 'task A', reviewPolicy: 'none' },
        { prompt: 'task B', reviewPolicy: 'diff_only' },
        { prompt: 'task C' }, // omitted → default 'full'
      ],
    });

    const entry = registry.get('b-multi-mixed')!;
    expect(entry.taskEnvelopes).toHaveLength(3);
    expect(entry.taskEnvelopes![0]!.snapshot().reviewPolicy).toBe('none');
    expect(entry.taskEnvelopes![1]!.snapshot().reviewPolicy).toBe('diff_only');
    expect(entry.taskEnvelopes![2]!.snapshot().reviewPolicy).toBe('full');
  });
});

describe('TaskEnvelopeStore.setReviewPolicy', () => {
  it('overwrites reviewPolicy and notifies', () => {
    const reasons: string[] = [];
    const env = TaskEnvelopeStore.create({
      taskId: 't:0', batchId: 't', taskIndex: 0,
      route: 'delegate', agentType: 'standard',
      client: 'c', mainModel: 'm', cwd: '/tmp/x',
      reviewPolicy: 'full' as const,
    }, (reason) => { reasons.push(reason); });

    env.setReviewPolicy('none');
    expect(env.snapshot().reviewPolicy).toBe('none');
    expect(reasons).toContain('setReviewPolicy');
  });

  it('no-op when value is unchanged (avoids notify churn)', () => {
    const reasons: string[] = [];
    const env = TaskEnvelopeStore.create({
      taskId: 't:0', batchId: 't', taskIndex: 0,
      route: 'delegate', agentType: 'standard',
      client: 'c', mainModel: 'm', cwd: '/tmp/x',
      reviewPolicy: 'full' as const,
    }, (reason) => { reasons.push(reason); });

    const before = reasons.length;
    env.setReviewPolicy('full');
    expect(env.snapshot().reviewPolicy).toBe('full');
    expect(reasons.length).toBe(before);
  });

  it('throws after seal()', () => {
    const env = TaskEnvelopeStore.create({
      taskId: 't:0', batchId: 't', taskIndex: 0,
      route: 'delegate', agentType: 'standard',
      client: 'c', mainModel: 'm', cwd: '/tmp/x',
      reviewPolicy: 'full' as const,
    });
    env.seal({ status: 'done', stopReason: 'normal', realFilesChanged: [] });
    expect(() => env.setReviewPolicy('none')).toThrow(/setReviewPolicy/);
  });
});
