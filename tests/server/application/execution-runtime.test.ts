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

function baseAgentsConfig(stateDir: string): MultiModelConfig {
  return {
    agents: {
      standard: { type: 'codex', model: 'mock-standard', baseUrl: 'http://mock.local' },
      complex: { type: 'codex', model: 'mock-complex', baseUrl: 'http://mock.local' },
      main: { type: 'codex', model: 'mock-main', baseUrl: 'http://mock.local' },
    },
    // The `investigate` preprocessor resolves its own derived code-corpus
    // — every test here dispatches `type: 'investigate'`, so this must be
    // present. Reuses the SAME per-test `stateDir` the `ExecutionStore` in
    // `beforeEach` is already keyed off, mirroring real server wiring where
    // both live under one `server.stateDir`.
    server: { stateDir },
  } as unknown as MultiModelConfig;
}

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
    toolCalls: [],
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
  let TEST_CONFIG: MultiModelConfig;

  beforeEach(() => {
    cwd = mkdtempSync(join(tmpdir(), 'mma-exec-runtime-'));
    stateDir = mkdtempSync(join(tmpdir(), 'mma-exec-state-'));
    taskRegistry = new TaskRegistry();
    projectRegistry = new ProjectRegistry({ cap: 10 });
    store = new ExecutionStore({ dbPath: join(stateDir, 'executions.db'), ttlMs: 3_600_000 });
    bus = new EnvelopeBus();
    TEST_CONFIG = baseAgentsConfig(stateDir);
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
      { clientName: 'claude-code', projectRoot: cwd },
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
      { clientName: 'claude-code', projectRoot: cwd },
    );
    expect(outcome.ok).toBe(true);
    const taskId = (outcome as { ok: true; taskId: string }).taskId;

    await waitTerminal(taskRegistry, taskId);
    const entry = taskRegistry.get(taskId)!;
    expect(entry.state).toBe('complete');
    expect(refcount()).toBe(0);
  });

  /**
   * The cost baseline is the CONFIGURED `agents.main` tier — never a worker tier.
   *
   * The runtime used to fall back to `config.agents[implTier].model`. That priced the
   * run against one of the two models that had just executed it, so
   * `savedVsMainCostUsd` stopped meaning "saved versus the model driving mma" and
   * started meaning "is the reviewer's model dearer per token than the implementer's"
   * — which on a cross-tier route reported a NEGATIVE saving for a run that saved
   * money.
   *
   * Both workers here run `claude-sonnet-5` and `main` runs `claude-opus-5`. The two
   * models have different rate cards, so pricing the SAME tokens against each yields
   * different numbers. Asserting the opus figure — and explicitly not the sonnet one —
   * is what proves which tier the baseline read.
   */
  it('prices the run against agents.main, not against the tier that executed it', async () => {
    const config = baseAgentsConfig(stateDir);
    config.agents!.standard.model = 'claude-sonnet-5';
    config.agents!.complex.model = 'claude-sonnet-5';
    config.agents!.main.model = 'claude-opus-5';
    const runtime = new ExecutionRuntime({
      config, bus, taskRegistry, projectRegistry, store,
      resolveAgentFn: resolverFor(workingProvider('an answer')),
    });

    const outcome = await runtime.submit(
      { type: 'investigate', prompt: 'what is up' } as never,
      { clientName: 'claude-code', projectRoot: cwd },
    );
    expect(outcome.ok).toBe(true);
    const taskId = (outcome as { ok: true; taskId: string }).taskId;

    await waitTerminal(taskRegistry, taskId);
    const metrics = (taskRegistry.get(taskId)!.result as {
      metrics: {
        mainEquivalentCostUsd: number | null;
        savedVsMainCostUsd: number | null;
        totalCostUsd: number;
        totalUsage: { inputTokens: number; outputTokens: number; cachedReadTokens: number; cachedNonReadTokens: number };
      };
    }).metrics;

    // Price the run's OWN reported usage at each card, so the expectation does not
    // hard-code how many turns the mock provider happened to run.
    const u = metrics.totalUsage;
    const at = (inp: number, out: number, cr: number, cw: number): number =>
      (u.inputTokens * inp + u.outputTokens * out + u.cachedReadTokens * cr + u.cachedNonReadTokens * cw) / 1e6;
    const opus = at(5, 25, 0.5, 6.25);
    const sonnet = at(3, 15, 0.3, 3.75);
    expect(opus).not.toBeCloseTo(sonnet, 10); // the two cards must actually differ

    expect(metrics.mainEquivalentCostUsd).toBeCloseTo(opus, 10);
    expect(metrics.mainEquivalentCostUsd).not.toBeCloseTo(sonnet, 10);
    expect(metrics.savedVsMainCostUsd).toBeCloseTo(opus - metrics.totalCostUsd, 10);
  });

  /**
   * A main tier the price registry does not recognise yields NO comparison rather
   * than a fabricated one. `agents.main` is required config, so the tier always
   * exists — but a user may legitimately declare a model mma has no rate card for.
   */
  it('reports a null comparison when agents.main names an unpriced model', async () => {
    const config = baseAgentsConfig(stateDir);
    config.agents!.main.model = 'some-unprofiled-local-model';
    const runtime = new ExecutionRuntime({
      config, bus, taskRegistry, projectRegistry, store,
      resolveAgentFn: resolverFor(workingProvider('an answer')),
    });

    const outcome = await runtime.submit(
      { type: 'investigate', prompt: 'what is up' } as never,
      { clientName: 'claude-code', projectRoot: cwd },
    );
    const taskId = (outcome as { ok: true; taskId: string }).taskId;
    await waitTerminal(taskRegistry, taskId);
    const metrics = (taskRegistry.get(taskId)!.result as {
      metrics: { mainEquivalentCostUsd: number | null; savedVsMainCostUsd: number | null; totalCostUsd: number };
    }).metrics;
    expect(metrics.mainEquivalentCostUsd).toBeNull();
    expect(metrics.savedVsMainCostUsd).toBeNull();
    // The run's own cost is unaffected — only the comparison is withheld.
    expect(metrics.totalCostUsd).toBeGreaterThan(0);
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
      { clientName: 'claude-code', projectRoot: cwd },
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
      { clientName: 'claude-code', projectRoot: cwd },
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
      { clientName: 'claude-code', projectRoot: cwd },
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
      { clientName: 'claude-code', projectRoot: cwd },
    );
    expect(outcome.ok).toBe(false);
    expect((outcome as { ok: false; error: { kind: string } }).error.kind).toBe('agent_not_configured');
  });
});
