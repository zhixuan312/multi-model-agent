// ExecutionRuntime — application-layer tests with no HTTP involved.
// Regression focus: context-block pins must be released via the ExecutionScope
// even when the pipeline CRASHES (previously a runner crash skipped the unpin
// loop, leaving the block pinned forever — DELETE /context-blocks/:id 409'd
// until server restart).
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ExecutionRuntime } from '../../../packages/server/src/application/execution-runtime.js';
import { ExecutionStore } from '../../../packages/server/src/application/execution-store.js';
import { ProjectRegistry } from '../../../packages/server/src/application/project-registry.js';
import { TaskRegistry } from '../../../packages/core/src/unified/task-registry.js';
import { EnvelopeBus } from '../../../packages/core/src/events/envelope-bus.js';
import type { MultiModelConfig, ResolvedAgent, AgentType } from '@zhixuan92/multi-model-agent-core';
import type { Provider, SessionOpts, Session, TurnResult } from '../../../packages/core/src/types/run-result.js';

const TEST_CONFIG = {
  agents: {
    standard: { type: 'codex', model: 'mock-standard', baseUrl: 'http://mock.local' },
    complex: { type: 'codex', model: 'mock-complex', baseUrl: 'http://mock.local' },
  },
} as unknown as MultiModelConfig;

function okTurn(output: string): TurnResult {
  return {
    output,
    usage: { inputTokens: 10, outputTokens: 5, cachedReadTokens: 0, cachedNonReadTokens: 0 },
    filesWritten: [],
    usedShell: false,
    turns: 1,
    durationMs: 3,
    costUSD: 0.001,
    terminationReason: 'ok',
  };
}

function workingProvider(output: string): Provider {
  return {
    name: 'mock:working',
    config: { type: 'codex', model: 'mock', baseUrl: 'http://mock.local' } as Provider['config'],
    openSession(_opts: SessionOpts): Session {
      return {
        async send(): Promise<TurnResult> { return okTurn(output); },
        async close(): Promise<void> { /* no-op */ },
        getSessionId(): string | null { return null; },
      };
    },
  };
}

function crashingProvider(): Provider {
  return {
    name: 'mock:crashing',
    config: { type: 'codex', model: 'mock', baseUrl: 'http://mock.local' } as Provider['config'],
    openSession(): Session {
      throw new Error('provider exploded before any session opened');
    },
  };
}

function resolverFor(provider: Provider): (tier: AgentType, config: MultiModelConfig) => ResolvedAgent {
  return (tier) => ({ slot: tier, provider });
}

async function waitTerminal(taskRegistry: TaskRegistry, taskId: string): Promise<void> {
  const deadline = Date.now() + 5_000;
  while (!taskRegistry.isTerminal(taskId)) {
    if (Date.now() > deadline) throw new Error(`task ${taskId} never reached terminal state`);
    await new Promise((r) => setTimeout(r, 10));
  }
}

describe('ExecutionRuntime', () => {
  let cwd: string;
  let stateDir: string;
  let taskRegistry: TaskRegistry;
  let projectRegistry: ProjectRegistry;
  let store: ExecutionStore;
  let bus: EnvelopeBus;

  beforeEach(() => {
    cwd = mkdtempSync(join(tmpdir(), 'mma-exec-runtime-'));
    stateDir = mkdtempSync(join(tmpdir(), 'mma-exec-state-'));
    taskRegistry = new TaskRegistry();
    projectRegistry = new ProjectRegistry({ cap: 10 });
    store = new ExecutionStore({ dbPath: join(stateDir, 'executions.db'), ttlMs: 3_600_000 });
    bus = new EnvelopeBus();
  });
  afterEach(() => {
    store.close();
    rmSync(cwd, { recursive: true, force: true });
    rmSync(stateDir, { recursive: true, force: true });
  });

  function registerBlock(content: string): { id: string; refcount: () => number } {
    const reserve = projectRegistry.reserveProject(cwd);
    if (!reserve.ok) throw new Error(`reserve failed: ${reserve.error}`);
    projectRegistry.cancelReservation(cwd);
    const block = reserve.projectContext.contextBlocks.register(content);
    return { id: block.id, refcount: () => reserve.projectContext.contextBlocks.refcount(block.id) };
  }

  it('releases context-block pins when the pipeline crashes (scope drain)', async () => {
    const { id, refcount } = registerBlock('reference material');
    const runtime = new ExecutionRuntime({
      config: TEST_CONFIG, bus, taskRegistry, projectRegistry, store,
      resolveAgentFn: resolverFor(crashingProvider()),
    });

    const outcome = await runtime.submit(
      { type: 'investigate', prompt: 'what is up', contextBlockIds: [id] } as never,
      { clientName: 'claude-code', mainModel: 'claude-opus-5', projectRoot: cwd },
    );
    expect(outcome.ok).toBe(true);
    const taskId = (outcome as { ok: true; taskId: string }).taskId;

    await waitTerminal(taskRegistry, taskId);
    const entry = taskRegistry.get(taskId)!;
    expect(entry.state).toBe('failed');
    expect((entry.result as { error: { code: string } }).error.code).toBe('runner_crash');
    // The crash path must still release the pin.
    expect(refcount()).toBe(0);
  });

  it('releases context-block pins on the normal completion path', async () => {
    const { id, refcount } = registerBlock('reference material');
    const runtime = new ExecutionRuntime({
      config: TEST_CONFIG, bus, taskRegistry, projectRegistry, store,
      resolveAgentFn: resolverFor(workingProvider('an answer')),
    });

    const outcome = await runtime.submit(
      { type: 'investigate', prompt: 'what is up', contextBlockIds: [id] } as never,
      { clientName: 'claude-code', mainModel: 'claude-opus-5', projectRoot: cwd },
    );
    expect(outcome.ok).toBe(true);
    const taskId = (outcome as { ok: true; taskId: string }).taskId;

    await waitTerminal(taskRegistry, taskId);
    const entry = taskRegistry.get(taskId)!;
    expect(entry.state).toBe('complete');
    expect(refcount()).toBe(0);
  });

  /** Provider whose turn hangs until the execution's abort signal fires, then
   *  resolves an 'aborted' turn — the shape the real runners produce when
   *  killGracefully / the SDK abort tears the worker down. */
  function abortAwareHangingProvider(): Provider {
    return {
      name: 'mock:abort-aware',
      config: { type: 'codex', model: 'mock', baseUrl: 'http://mock.local' } as Provider['config'],
      openSession(opts: SessionOpts): Session {
        return {
          send(): Promise<TurnResult> {
            return new Promise((resolve) => {
              const finish = () => resolve({
                ...okTurn('partial output'),
                terminationReason: 'aborted' as const,
                errorCode: 'aborted',
              });
              if (opts.abortSignal.aborted) { finish(); return; }
              opts.abortSignal.addEventListener('abort', finish, { once: true });
            });
          },
          async close(): Promise<void> { /* no-op */ },
          getSessionId(): string | null { return null; },
        };
      },
    };
  }

  it('cancel() on a running execution reaches terminal cancelled in registry AND store', async () => {
    const runtime = new ExecutionRuntime({
      config: TEST_CONFIG, bus, taskRegistry, projectRegistry, store,
      resolveAgentFn: resolverFor(abortAwareHangingProvider()),
    });

    const outcome = await runtime.submit(
      { type: 'investigate', prompt: 'hangs until cancelled' } as never,
      { clientName: 'claude-code', mainModel: 'claude-opus-5', projectRoot: cwd },
    );
    expect(outcome.ok).toBe(true);
    const taskId = (outcome as { ok: true; taskId: string }).taskId;

    // Let the executor start and the implementer turn begin hanging.
    await new Promise((r) => setTimeout(r, 30));
    expect(taskRegistry.isTerminal(taskId)).toBe(false);

    const cancelRes = runtime.cancel(taskId);
    expect(cancelRes.outcome).toBe('requested');
    // The flag is visible while the runner winds down.
    expect(taskRegistry.get(taskId)!.cancellationRequestedAt).not.toBeNull();

    await waitTerminal(taskRegistry, taskId);
    const entry = taskRegistry.get(taskId)!;
    expect(entry.state).toBe('cancelled');
    const envelope = entry.result as { task: { status: string }; error: { code: string } };
    expect(envelope.task.status).toBe('cancelled');
    expect(envelope.error.code).toBe('aborted');

    // Durable mirror agrees.
    const record = store.get(taskId)!;
    expect(record.state).toBe('cancelled');
    expect(record.cancellationRequestedAt).not.toBeNull();
    expect(JSON.parse(record.resultJson!).task.status).toBe('cancelled');

    // Idempotent: a second cancel reports the terminal state.
    expect(runtime.cancel(taskId).outcome).toBe('terminal');
  });

  it('cancel() before the executor starts finishes cancelled with zero sessions', async () => {
    let sessionsOpened = 0;
    const countingProvider: Provider = {
      name: 'mock:counting',
      config: { type: 'codex', model: 'mock', baseUrl: 'http://mock.local' } as Provider['config'],
      openSession(): Session {
        sessionsOpened += 1;
        return {
          async send(): Promise<TurnResult> { return okTurn('never'); },
          async close(): Promise<void> { /* no-op */ },
          getSessionId(): string | null { return null; },
        };
      },
    };
    const runtime = new ExecutionRuntime({
      config: TEST_CONFIG, bus, taskRegistry, projectRegistry, store,
      resolveAgentFn: resolverFor(countingProvider),
    });

    const outcome = await runtime.submit(
      { type: 'investigate', prompt: 'q' } as never,
      { clientName: 'claude-code', mainModel: null, projectRoot: cwd },
    );
    const taskId = (outcome as { ok: true; taskId: string }).taskId;
    // Cancel in the same tick — before setImmediate runs the executor.
    expect(runtime.cancel(taskId).outcome).toBe('requested');

    await waitTerminal(taskRegistry, taskId);
    expect(taskRegistry.get(taskId)!.state).toBe('cancelled');
    expect(store.get(taskId)!.state).toBe('cancelled');
    expect(sessionsOpened).toBe(0);
  });

  it('cancel() on an unknown task reports not_found', () => {
    const runtime = new ExecutionRuntime({
      config: TEST_CONFIG, bus, taskRegistry, projectRegistry, store,
      resolveAgentFn: resolverFor(workingProvider('x')),
    });
    expect(runtime.cancel('no-such-task').outcome).toBe('not_found');
  });

  it('completion wins the race against a late cancel (first writer wins)', async () => {
    const runtime = new ExecutionRuntime({
      config: TEST_CONFIG, bus, taskRegistry, projectRegistry, store,
      resolveAgentFn: resolverFor(workingProvider('finished answer')),
    });
    const outcome = await runtime.submit(
      { type: 'investigate', prompt: 'q' } as never,
      { clientName: 'claude-code', mainModel: null, projectRoot: cwd },
    );
    const taskId = (outcome as { ok: true; taskId: string }).taskId;
    await waitTerminal(taskRegistry, taskId);
    expect(taskRegistry.get(taskId)!.state).toBe('complete');

    // Cancel after completion: terminal state stands, store unchanged.
    expect(runtime.cancel(taskId).outcome).toBe('terminal');
    expect(taskRegistry.get(taskId)!.state).toBe('complete');
    expect(store.get(taskId)!.state).toBe('complete');
  });

  it('rejects submission when no agent can be resolved', async () => {
    const runtime = new ExecutionRuntime({
      config: { agents: undefined } as unknown as MultiModelConfig,
      bus, taskRegistry, projectRegistry, store,
    });
    const outcome = await runtime.submit(
      { type: 'investigate', prompt: 'q' } as never,
      { clientName: 'claude-code', mainModel: null, projectRoot: cwd },
    );
    expect(outcome.ok).toBe(false);
    expect((outcome as { ok: false; error: { kind: string } }).error.kind).toBe('agent_not_configured');
  });
});
