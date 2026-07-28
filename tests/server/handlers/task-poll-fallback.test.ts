// GET /task/:taskId durable fallback — after a daemon restart the in-memory
// registry is empty, but terminal results (including boot-reconciled
// `interrupted` envelopes) must still be retrievable from the ExecutionStore.
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { ServerResponse, IncomingMessage } from 'node:http';
import { buildTaskPollHandler } from '../../../packages/server/src/http/handlers/unified-task.js';
import { ExecutionRuntime } from '../../../packages/server/src/application/execution-runtime.js';
import { ExecutionStore } from '../../../packages/server/src/application/execution-store.js';
import { ProjectRegistry } from '../../../packages/server/src/application/project-registry.js';
import { reconcileOnBoot } from '../../../packages/server/src/application/reconcile.js';
import { TaskRegistry } from '../../../packages/core/src/unified/task-registry.js';
import { EnvelopeBus } from '../../../packages/core/src/events/envelope-bus.js';
import type { MultiModelConfig } from '@zhixuan92/multi-model-agent-core';

const DEAD_PID = 999_999_999;

function fakeRes(): { res: ServerResponse; status: () => number; body: () => unknown } {
  let statusCode = 0;
  let payload = '';
  const res = {
    writeHead(code: number) { statusCode = code; return res; },
    end(chunk?: string) { if (chunk) payload = chunk; },
    setHeader() { /* no-op */ },
  } as unknown as ServerResponse;
  return { res, status: () => statusCode, body: () => JSON.parse(payload) };
}

const CTX = { url: new URL('http://127.0.0.1/task/x'), callerClient: 'claude-code' as const, mainModel: null };

describe('GET /task/:taskId durable fallback', () => {
  let dir: string;
  let store: ExecutionStore;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'mma-poll-fallback-'));
    store = new ExecutionStore({ dbPath: join(dir, 'executions.db'), ttlMs: 3_600_000 });
  });
  afterEach(() => {
    store.close();
    rmSync(dir, { recursive: true, force: true });
  });

  function freshHandler() {
    // Post-restart world: EMPTY registry, same durable store.
    const taskRegistry = new TaskRegistry();
    const runtime = new ExecutionRuntime({
      config: {} as MultiModelConfig,
      bus: new EnvelopeBus(),
      taskRegistry,
      projectRegistry: new ProjectRegistry({ cap: 10 }),
      store,
    });
    return buildTaskPollHandler({ runtime, taskRegistry, store });
  }

  it('serves a terminal result that survived a restart', async () => {
    store.admit('t-done', 'investigate', '/repo', DEAD_PID);
    store.complete('t-done', JSON.stringify({ task: { taskId: 't-done', status: 'done' }, error: null }));

    const { res, status, body } = fakeRes();
    await freshHandler()({} as IncomingMessage, res, { taskId: 't-done' }, CTX);
    expect(status()).toBe(200);
    expect((body() as { task: { status: string } }).task.status).toBe('done');
  });

  it('serves the interrupted envelope produced by boot reconciliation', async () => {
    store.admit('t-was-running', 'execute_plan', '/repo', DEAD_PID);
    reconcileOnBoot(store, process.pid);

    const { res, status, body } = fakeRes();
    await freshHandler()({} as IncomingMessage, res, { taskId: 't-was-running' }, CTX);
    expect(status()).toBe(200);
    const envelope = body() as { task: { status: string }; error: { code: string; retryable: boolean } };
    expect(envelope.task.status).toBe('interrupted');
    expect(envelope.error.code).toBe('daemon_restarted');
    expect(envelope.error.retryable).toBe(true);
  });

  it('404s for ids the store has never seen', async () => {
    const { res, status } = fakeRes();
    await freshHandler()({} as IncomingMessage, res, { taskId: 'never-existed' }, CTX);
    expect(status()).toBe(404);
  });
});
