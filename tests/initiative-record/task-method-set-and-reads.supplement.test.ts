/**
 * Supplementary coverage for Task I-3 (SPEC-005 Method Registry) beyond the plan-authored
 * `task-method-transport.test.ts`: edge cases named in the task's Contract `Errors`/`Behavior`
 * bullets that the plan-authored acceptance test does not itself exercise — create-time
 * `unknown_method` rejection, `initiative_task_set_method`'s `not_found` / `revision_conflict`
 * paths, exactly-one-Event-per-mutation plus idempotency replay producing no second Event, and
 * the `method_get`/`method_list` read dispatch through `InitiativeRecordRuntime.execute()`. Adds
 * coverage; never edits the plan-authored test.
 */
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { InitiativeRecordStore } from '../../packages/core/src/initiative-record/index.js';
import { InitiativeRecordRuntime } from '../../packages/server/src/application/initiative-record-runtime.js';

const provenance = {
  actor_type: 'agent' as const,
  actor_id: 'host-a',
  interface: 'mcp',
  initiated_by: 'host-a',
  authorized_by: 'host-a',
  timestamp: '2026-08-13T00:00:00.000Z',
  source: 'test',
};

function openStore() {
  const dir = mkdtempSync(join(tmpdir(), 'mma-task-method-supp-'));
  const store = InitiativeRecordStore.open({ dbPath: join(dir, 'initiatives.db') });
  return {
    store,
    dir,
    cleanup: () => {
      store.close();
      rmSync(dir, { recursive: true, force: true });
    },
  };
}

let seedCounter = 0;

function seedInitiative(store: InitiativeRecordStore) {
  const slug = `mma-${++seedCounter}`;
  const product = store.execute({ operation: 'product_create', input: { name: 'MMA', slug }, expected_revision: 0, provenance }) as {
    uuid: string;
  };
  const initiative = store.execute({
    operation: 'initiative_create',
    input: { product_id: product.uuid, title: 'I', goal: 'G', status: 'open', outcome: null },
    expected_revision: 0,
    provenance,
  }) as { uuid: string };
  return initiative;
}

function thrownCode(fn: () => unknown): string | undefined {
  try {
    fn();
  } catch (error) {
    return (error as { code?: string }).code;
  }
  return undefined;
}

describe('Task Method set/create — supplementary edge cases', () => {
  it('rejects an unregistered create-time method as unknown_method before any write', () => {
    const { store, cleanup } = openStore();
    try {
      const initiative = seedInitiative(store);
      expect(
        thrownCode(() =>
          store.execute({
            operation: 'initiative_task_create',
            input: {
              initiative_id: initiative.uuid,
              title: 'T',
              goal: 'G',
              status: 'open',
              outcome: null,
              workspace_ids: [],
              resource_ids: [],
              method: 'missing@1',
            },
            expected_revision: 0,
            provenance,
          }),
        ),
      ).toBe('unknown_method');
      // No partial write: the Initiative's Task list stays empty.
      expect(store.listInitiativeTasks({ initiative_id: initiative.uuid })).toEqual([]);
    } finally {
      cleanup();
    }
  });

  it('creates a Task with a registered method and reads it back unchanged', () => {
    const { store, cleanup } = openStore();
    try {
      const initiative = seedInitiative(store);
      const task = store.execute({
        operation: 'initiative_task_create',
        input: {
          initiative_id: initiative.uuid,
          title: 'T',
          goal: 'G',
          status: 'open',
          outcome: null,
          workspace_ids: [],
          resource_ids: [],
          method: 'research@1',
        },
        expected_revision: 0,
        provenance,
      }) as { uuid: string; method: string | null };
      expect(task.method).toBe('research@1');
      expect(store.getInitiativeTask({ uuid: task.uuid }).method).toBe('research@1');
    } finally {
      cleanup();
    }
  });

  it('rejects initiative_task_set_method with not_found for a Task under a different Initiative', () => {
    const { store, cleanup } = openStore();
    try {
      const initiative = seedInitiative(store);
      const otherInitiative = seedInitiative(store);
      const task = store.execute({
        operation: 'initiative_task_create',
        input: { initiative_id: initiative.uuid, title: 'T', goal: 'G', status: 'open', outcome: null, workspace_ids: [], resource_ids: [] },
        expected_revision: 0,
        provenance,
      }) as { uuid: string; revision: number };
      expect(
        thrownCode(() =>
          store.execute({
            operation: 'initiative_task_set_method',
            input: { initiative: { uuid: otherInitiative.uuid }, task: { uuid: task.uuid }, method: 'software-change@1' },
            expected_revision: task.revision,
            provenance,
          }),
        ),
      ).toBe('not_found');
    } finally {
      cleanup();
    }
  });

  it('rejects initiative_task_set_method with not_found for an unknown Initiative', () => {
    const { store, cleanup } = openStore();
    try {
      expect(
        thrownCode(() =>
          store.execute({
            operation: 'initiative_task_set_method',
            input: { initiative: { uuid: randomUUID() }, task: { uuid: randomUUID() }, method: null },
            expected_revision: 0,
            provenance,
          }),
        ),
      ).toBe('not_found');
    } finally {
      cleanup();
    }
  });

  it('rejects initiative_task_set_method with revision_conflict for a stale expected_revision', () => {
    const { store, cleanup } = openStore();
    try {
      const initiative = seedInitiative(store);
      const task = store.execute({
        operation: 'initiative_task_create',
        input: { initiative_id: initiative.uuid, title: 'T', goal: 'G', status: 'open', outcome: null, workspace_ids: [], resource_ids: [] },
        expected_revision: 0,
        provenance,
      }) as { uuid: string; revision: number };
      expect(
        thrownCode(() =>
          store.execute({
            operation: 'initiative_task_set_method',
            input: { initiative: { uuid: initiative.uuid }, task: { uuid: task.uuid }, method: 'software-change@1' },
            expected_revision: task.revision + 1,
            provenance,
          }),
        ),
      ).toBe('revision_conflict');
    } finally {
      cleanup();
    }
  });

  it('records exactly one task_method_set Event per successful call and no second Event on idempotency replay', () => {
    const { store, cleanup } = openStore();
    try {
      const initiative = seedInitiative(store);
      const task = store.execute({
        operation: 'initiative_task_create',
        input: { initiative_id: initiative.uuid, title: 'T', goal: 'G', status: 'open', outcome: null, workspace_ids: [], resource_ids: [] },
        expected_revision: 0,
        provenance,
      }) as { uuid: string; revision: number };
      const request = {
        operation: 'initiative_task_set_method' as const,
        input: { initiative: { uuid: initiative.uuid }, task: { uuid: task.uuid }, method: 'software-change@1' },
        expected_revision: task.revision,
        idempotency_key: 'set-method-once',
        provenance,
      };
      const first = store.execute(request) as { method: string | null; revision: number };
      expect(first.method).toBe('software-change@1');
      const events = store.listEvents({ initiative_id: initiative.uuid }).filter((event) => event.event_type === 'task_method_set');
      expect(events).toHaveLength(1);
      expect(events[0]!.payload).toEqual({ previous_method: null, new_method: 'software-change@1' });

      // Idempotency replay: SAME operation/input/expected_revision/provenance (minus timestamp)
      // and SAME idempotency_key returns the cached result without a second Event.
      const replay = store.execute(request) as { method: string | null; revision: number };
      expect(replay).toEqual(first);
      const eventsAfterReplay = store.listEvents({ initiative_id: initiative.uuid }).filter((event) => event.event_type === 'task_method_set');
      expect(eventsAfterReplay).toHaveLength(1);
    } finally {
      cleanup();
    }
  });
});

describe('InitiativeRecordRuntime — Method registry read dispatch (Task I-3)', () => {
  function openRuntime() {
    const dir = mkdtempSync(join(tmpdir(), 'mma-method-runtime-supp-'));
    const runtime = InitiativeRecordRuntime.open({ stateDir: dir });
    return {
      runtime,
      cleanup: () => {
        runtime.close();
        rmSync(dir, { recursive: true, force: true });
      },
    };
  }

  it('method_get returns the registered declaration through execute()', () => {
    const { runtime, cleanup } = openRuntime();
    try {
      const result = runtime.execute({ operation: 'method_get', input: { id: 'software-change@1' } }) as { id: string; name: string };
      expect(result.id).toBe('software-change@1');
      expect(result.name).toBe('Software change');
    } finally {
      cleanup();
    }
  });

  it('method_get throws unknown_method for an unregistered identifier through execute()', () => {
    const { runtime, cleanup } = openRuntime();
    try {
      expect(thrownCode(() => runtime.execute({ operation: 'method_get', input: { id: 'missing@1' } }))).toBe('unknown_method');
    } finally {
      cleanup();
    }
  });

  it('method_list returns all ten registered declarations through execute()', () => {
    const { runtime, cleanup } = openRuntime();
    try {
      const result = runtime.execute({ operation: 'method_list', input: {} }) as Array<{ id: string }>;
      expect(result).toHaveLength(10);
      expect(result.map((m) => m.id)).toEqual([...result.map((m) => m.id)].sort());
    } finally {
      cleanup();
    }
  });
});
