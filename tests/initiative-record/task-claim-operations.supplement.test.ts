import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { InitiativeRecordStore } from '../../packages/core/src/initiative-record/index.js';

/**
 * Supplementary coverage for Task I-2 (SPEC-003 Phase B) beyond the
 * plan-authored `task-claim-operations.test.ts`: edge cases named in the
 * task's Contract `Errors`/`Behavior` bullets that the plan-authored
 * acceptance test does not itself exercise — an unlisted transition, execution
 * recording on a terminal Task, the `claimed → in_progress` ownership check, a
 * stale-revision rejection, and no-partial-write rollback on a rejected
 * mutation. Adds coverage; never edits the plan-authored test.
 */
const provenance = {
  actor_type: 'agent',
  actor_id: 'host-a',
  interface: 'mcp',
  initiated_by: 'host-a',
  authorized_by: 'host-a',
  timestamp: '2026-08-13T00:00:00.000Z',
  source: 'test',
};
const asHost = (id: string) => ({ ...provenance, actor_id: id, initiated_by: id, authorized_by: id });

describe('Task claim operations — supplementary edge cases', () => {
  function openStore() {
    const dir = mkdtempSync(join(tmpdir(), 'mma-task-claim-supp-'));
    const store = InitiativeRecordStore.open({ dbPath: join(dir, 'initiatives.db') });
    return {
      store,
      cleanup: () => {
        store.close();
        rmSync(dir, { recursive: true, force: true });
      },
    };
  }

  function seedTask(store: InitiativeRecordStore) {
    const product = store.execute({ operation: 'product_create', input: { name: 'MMA', slug: 'mma' }, expected_revision: 0, provenance }) as { uuid: string };
    const initiative = store.execute({
      operation: 'initiative_create',
      input: { product_id: product.uuid, title: 'I', goal: 'G', status: 'open', outcome: null },
      expected_revision: 0,
      provenance,
    }) as { uuid: string };
    const task = store.execute({
      operation: 'initiative_task_create',
      input: { initiative_id: initiative.uuid, title: 'T', goal: 'G', status: 'open', outcome: null, workspace_ids: [], resource_ids: [] },
      expected_revision: 0,
      provenance,
    }) as { uuid: string };
    return task;
  }

  it('rejects an unlisted transition as invalid_task_transition', () => {
    const { store, cleanup } = openStore();
    try {
      const task = seedTask(store);
      store.execute({ operation: 'initiative_task_claim', input: { uuid: task.uuid }, expected_revision: 0, provenance });
      // `claimed` only permits `-> in_progress` in TASK_EXECUTION_TRANSITIONS; `claimed -> completed`
      // via the execution operation is unlisted (completing a Task uses `initiative_task_complete`,
      // not `initiative_task_execution`), and `completed` is a valid enum member so this exercises the
      // store's matrix check rather than a Zod enum rejection.
      expect(() =>
        store.execute({
          operation: 'initiative_task_execution',
          input: { uuid: task.uuid, execution_ref: 'execution-2', transition: 'completed', outcome: 'succeeded' },
          expected_revision: 1,
          provenance,
        }),
      ).toThrow(/invalid_task_transition/);
    } finally {
      cleanup();
    }
  });

  it('rejects execution recording on a completed Task as invalid_task_transition', () => {
    const { store, cleanup } = openStore();
    try {
      const task = seedTask(store);
      store.execute({ operation: 'initiative_task_claim', input: { uuid: task.uuid }, expected_revision: 0, provenance });
      const completed = store.execute({
        operation: 'initiative_task_complete',
        input: { uuid: task.uuid, outcome: 'succeeded' },
        expected_revision: 1,
        provenance,
      }) as { revision: number };
      expect(() =>
        store.execute({
          operation: 'initiative_task_execution',
          input: { uuid: task.uuid, execution_ref: 'execution-late' },
          expected_revision: completed.revision,
          provenance,
        }),
      ).toThrow(/invalid_task_transition/);
    } finally {
      cleanup();
    }
  });

  it('rejects a claimed -> in_progress execution transition authorized by someone other than the claimant', () => {
    const { store, cleanup } = openStore();
    try {
      const task = seedTask(store);
      store.execute({ operation: 'initiative_task_claim', input: { uuid: task.uuid }, expected_revision: 0, provenance });
      expect(() =>
        store.execute({
          operation: 'initiative_task_execution',
          input: { uuid: task.uuid, execution_ref: 'execution-1', transition: 'in_progress' },
          expected_revision: 1,
          provenance: asHost('host-b'),
        }),
      ).toThrow(/task_claim_conflict/);
    } finally {
      cleanup();
    }
  });

  it('rejects a stale expected_revision as revision_conflict and leaves the Task unchanged', () => {
    const { store, cleanup } = openStore();
    try {
      const task = seedTask(store);
      expect(() =>
        store.execute({ operation: 'initiative_task_claim', input: { uuid: task.uuid }, expected_revision: 5, provenance }),
      ).toThrow(/revision_conflict/);
      // No partial write: the Task, its revision, and its status are untouched by the rejected mutation.
      const unchanged = store.getInitiativeTask({ uuid: task.uuid });
      expect(unchanged).toMatchObject({ status: 'open', claimed_by: null, revision: 0 });
    } finally {
      cleanup();
    }
  });

  it('rolls back the whole transaction — no Task write and no Event on a rejected mutation', () => {
    const { store, cleanup } = openStore();
    try {
      const task = seedTask(store);
      const eventsBefore = store.listEvents({}).length;
      // Claiming an already-open Task twice: the second attempt targets a stale revision and must fail cleanly.
      store.execute({ operation: 'initiative_task_claim', input: { uuid: task.uuid }, expected_revision: 0, provenance });
      const eventsAfterClaim = store.listEvents({}).length;
      expect(() =>
        store.execute({
          operation: 'initiative_task_claim',
          input: { uuid: task.uuid },
          expected_revision: 0, // stale — the Task is already at revision 1
          provenance,
        }),
      ).toThrow(/revision_conflict/);
      // The rejected mutation wrote no additional Event and left the Task at its post-claim state.
      expect(store.listEvents({}).length).toBe(eventsAfterClaim);
      expect(store.getInitiativeTask({ uuid: task.uuid })).toMatchObject({ status: 'claimed', claimed_by: 'host-a', revision: 1 });
      expect(eventsAfterClaim).toBeGreaterThan(eventsBefore);
    } finally {
      cleanup();
    }
  });
});
