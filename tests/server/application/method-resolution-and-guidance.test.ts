import { describe, expect, it, vi } from 'vitest';
import { ExecutionStore } from '../../../packages/server/src/application/execution-store.js';
import { ProjectRegistry } from '../../../packages/server/src/application/project-registry.js';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { TASK_TYPES, taskInputSchema } from '@zhixuan92/multi-model-agent-core';

const seams = vi.hoisted(() => ({ loadSkill: vi.fn(), pipeline: vi.fn() }));
vi.mock('@zhixuan92/multi-model-agent-core', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@zhixuan92/multi-model-agent-core')>()),
  loadSkill: seams.loadSkill,
  runTwoPhasePipeline: seams.pipeline,
}));

describe('Method resolution and validated prompt injection', () => {
  it('accepts method on every one of the twelve task types and leaves the route set unchanged', () => {
    // AC-1.7 needs coverage across ALL twelve routes, not one — a field added to only one
    // discriminated-union arm (or missing from commonFields) would not surface from a
    // single-type check. This also pins TASK_TYPES itself so a 13th route silently added or
    // removed fails here.
    expect(TASK_TYPES).toEqual([
      'audit', 'investigate', 'delegate', 'execute_plan',
      'review', 'debug', 'research', 'journal_recall', 'journal_record',
      'orchestrate', 'spec', 'plan',
    ]);
    const MINIMAL: Record<string, Record<string, unknown>> = {
      audit: { target: { inline: 'doc' } },
      investigate: { prompt: 'what does the ledger contain' },
      delegate: { prompt: 'write the summary' },
      execute_plan: { target: { paths: ['plan.md'] }, tasks: [] },
      review: { target: { inline: 'draft' } },
      debug: { prompt: 'the figure does not tie to source' },
      research: { prompt: 'what disclosure standards apply to this report' },
      journal_recall: { prompt: 'What did we learn about caching?' },
      journal_record: { prompt: 'We decided to use Redis for caching because...' },
      orchestrate: { prompt: 'Synthesize the exploration results into a specification.' },
      spec: { prompt: 'produce the report spec', target: { inline: 'decisions' } },
      plan: { prompt: 'plan the report', target: { inline: 'spec' } },
    };
    for (const type of TASK_TYPES) {
      const result = taskInputSchema.safeParse({ type, ...MINIMAL[type], method: 'software-change@1' });
      expect(result.success, `type ${type} must accept an optional method field`).toBe(true);
    }
  });

  it('rejects an invalid linked Task before every downstream side effect', async () => {
    const stateDir = mkdtempSync(join(tmpdir(), 'mma-method-order-'));
    try {
      const { ExecutionRuntime } = await import('../../../packages/server/src/application/execution-runtime.js');
      const { ExecutionRegistry } = await import('@zhixuan92/multi-model-agent-core');
      const { EnvelopeBus } = await import('@zhixuan92/multi-model-agent-core/events/envelope-bus');
      const registry = new ExecutionRegistry();
      const store = new ExecutionStore({ dbPath: join(stateDir, 'executions.db'), ttlMs: 60_000 });
      const register = vi.spyOn(registry, 'register');
      const admit = vi.spyOn(store, 'admit');
      const initiativeRuntime = { execute: vi.fn()
        .mockReturnValueOnce({ uuid: '00000000-0000-4000-8000-000000000001' })
        .mockImplementationOnce(() => { throw new Error('Task is closed'); }) };
      const runtime = new ExecutionRuntime({
        config: { agents: { standard: { type: 'codex', model: 'm' }, complex: { type: 'codex', model: 'm' }, main: { type: 'codex', model: 'm' } }, server: { stateDir } } as never,
        bus: new EnvelopeBus(), executionRegistry: registry, projectRegistry: new ProjectRegistry({ cap: 2 }), store,
        initiativeRuntime: initiativeRuntime as never,
      });
      const outcome = await runtime.submit({ type: 'review', target: { paths: ['/tmp/x.ts'] }, initiative: { initiative: { uuid: '00000000-0000-4000-8000-000000000001' }, task_uuid: '00000000-0000-4000-8000-000000000002', authorized_by: 'a' } } as never, { clientName: 'test', projectRoot: stateDir });
      expect(outcome).toMatchObject({ ok: false, error: { code: 'invalid_request' } });
      expect(initiativeRuntime.execute).toHaveBeenCalledTimes(2);
      expect(seams.loadSkill).not.toHaveBeenCalled();
      expect(seams.pipeline).not.toHaveBeenCalled();
      expect(register).not.toHaveBeenCalled();
      expect(admit).not.toHaveBeenCalled();
      expect(registry.allInFlight()).toEqual([]);
      expect(store.listUnconsumedOutbox()).toEqual([]);
      expect(store.interruptedSince(0)).toEqual([]);
      runtime.close(); store.close();
    } finally { rmSync(stateDir, { recursive: true, force: true }); }
  });

  it('rejects an invalid linked Task before resolving an unregistered explicit method', async () => {
    // The prior case proves the ordering when the request carries NO method at all. A request
    // that supplies its OWN (syntactically valid but unregistered) method is the case that would
    // actually catch a regression that resolves Method before linked-Task validation: if
    // resolution ran first, this would fail with `unknown_method` instead of the linked-Task
    // error, and `method_get` would have been called.
    const stateDir = mkdtempSync(join(tmpdir(), 'mma-method-order-both-invalid-'));
    try {
      const { ExecutionRuntime } = await import('../../../packages/server/src/application/execution-runtime.js');
      const { ExecutionRegistry } = await import('@zhixuan92/multi-model-agent-core');
      const { EnvelopeBus } = await import('@zhixuan92/multi-model-agent-core/events/envelope-bus');
      const registry = new ExecutionRegistry();
      const store = new ExecutionStore({ dbPath: join(stateDir, 'executions.db'), ttlMs: 60_000 });
      const register = vi.spyOn(registry, 'register');
      const admit = vi.spyOn(store, 'admit');
      const initiativeRuntime = { execute: vi.fn()
        .mockReturnValueOnce({ uuid: '00000000-0000-4000-8000-000000000001' })
        .mockImplementationOnce(() => { throw new Error('Task is closed'); }) };
      const runtime = new ExecutionRuntime({
        config: { agents: { standard: { type: 'codex', model: 'm' }, complex: { type: 'codex', model: 'm' }, main: { type: 'codex', model: 'm' } }, server: { stateDir } } as never,
        bus: new EnvelopeBus(), executionRegistry: registry, projectRegistry: new ProjectRegistry({ cap: 2 }), store,
        initiativeRuntime: initiativeRuntime as never,
      });
      const outcome = await runtime.submit({
        type: 'review', target: { paths: ['/tmp/x.ts'] }, method: 'missing@1',
        initiative: { initiative: { uuid: '00000000-0000-4000-8000-000000000001' }, task_uuid: '00000000-0000-4000-8000-000000000002', authorized_by: 'a' },
      } as never, { clientName: 'test', projectRoot: stateDir });
      // The linked-Task error wins — NOT unknown_method — proving resolution still runs after
      // validation even when the request supplies its own method.
      expect(outcome).toMatchObject({ ok: false, error: { code: 'invalid_request' } });
      expect(outcome).not.toMatchObject({ error: { kind: 'unknown_method' } });
      // Exactly the two linked-Task reads (initiative_get, initiative_task_get) — a third call
      // would be method_get, which must never fire once linked-Task validation has already failed.
      expect(initiativeRuntime.execute).toHaveBeenCalledTimes(2);
      expect(initiativeRuntime.execute).not.toHaveBeenCalledWith(expect.objectContaining({ operation: 'method_get' }));
      expect(seams.loadSkill).not.toHaveBeenCalled();
      expect(seams.pipeline).not.toHaveBeenCalled();
      expect(register).not.toHaveBeenCalled();
      expect(admit).not.toHaveBeenCalled();
      expect(registry.allInFlight()).toEqual([]);
      expect(store.listUnconsumedOutbox()).toEqual([]);
      expect(store.interruptedSince(0)).toEqual([]);
      runtime.close(); store.close();
    } finally { rmSync(stateDir, { recursive: true, force: true }); }
  });
});