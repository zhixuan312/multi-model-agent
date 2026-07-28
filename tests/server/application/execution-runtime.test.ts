// ExecutionRuntime — application-layer tests with no HTTP involved.
// Regression focus: context-block pins must be released via the ExecutionScope
// even when the pipeline CRASHES (previously a runner crash skipped the unpin
// loop, leaving the block pinned forever — DELETE /context-blocks/:id 409'd
// until server restart).
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ExecutionRuntime } from '../../../packages/server/src/application/execution-runtime.js';
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
  let taskRegistry: TaskRegistry;
  let projectRegistry: ProjectRegistry;
  let bus: EnvelopeBus;

  beforeEach(() => {
    cwd = mkdtempSync(join(tmpdir(), 'mma-exec-runtime-'));
    taskRegistry = new TaskRegistry();
    projectRegistry = new ProjectRegistry({ cap: 10 });
    bus = new EnvelopeBus();
  });
  afterEach(() => { rmSync(cwd, { recursive: true, force: true }); });

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
      config: TEST_CONFIG, bus, taskRegistry, projectRegistry,
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
      config: TEST_CONFIG, bus, taskRegistry, projectRegistry,
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

  it('rejects submission when no agent can be resolved', async () => {
    const runtime = new ExecutionRuntime({
      config: { agents: undefined } as unknown as MultiModelConfig,
      bus, taskRegistry, projectRegistry,
    });
    const outcome = await runtime.submit(
      { type: 'investigate', prompt: 'q' } as never,
      { clientName: 'claude-code', mainModel: null, projectRoot: cwd },
    );
    expect(outcome.ok).toBe(false);
    expect((outcome as { ok: false; error: { kind: string } }).error.kind).toBe('agent_not_configured');
  });
});
