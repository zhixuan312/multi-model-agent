/**
 * The field `claim` WRITES must be the field the other transitions READ.
 *
 * `initiative_task_claim` set `claimed_by = provenance.actor_id`. Every operation that later checks
 * ownership compares against `provenance.authorized_by`:
 *
 *   release   sqlite-store.ts:2242   `row.claimed_by !== provenance.authorized_by`
 *   complete  sqlite-store.ts:2277   same
 *   execution sqlite-store.ts:2302   `claimed → in_progress` requires authorized_by === claimed_by
 *
 * So a caller whose two provenance fields differ could claim a Task and then never release,
 * complete, or advance it — permanently stuck `claimed`, `task_claim_conflict` on every attempt.
 *
 * That is this engine's own configuration. `application/initiative-linker.ts` sets
 * `actor_id: 'system:initiative-linker'` (a constant) and carries the real caller forward in
 * `authorized_by`, so for the linker the two ALWAYS differ.
 *
 * Why the suite could not see it: every existing claim test builds provenance through
 * `asHost = (id) => ({ ...p, actor_id: id, initiated_by: id, authorized_by: id })`. With all three
 * fields equal, writing one and reading another is indistinguishable from correct. It took a caller
 * that sets them to DIFFERENT real values — the full-smoke harness — to produce the failure.
 *
 * Every case below therefore uses provenance whose three identity fields are distinct. That is the
 * whole point of the file: an assertion that cannot tell the fields apart cannot catch this class.
 */
import { describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { InitiativeRecordStore } from '../../packages/core/src/initiative-record/sqlite-store.js';

/** Three DIFFERENT identities, which is what makes this file able to fail. */
const DISTINCT = {
  actor_type: 'agent' as const,
  actor_id: 'system:initiative-linker',
  interface: 'mcp' as const,
  initiated_by: 'smoke-harness',
  authorized_by: 'full-smoke',
  timestamp: '2026-08-16T00:00:00.000Z',
  source: 'test',
};

function withStore<T>(fn: (store: InitiativeRecordStore) => T): T {
  const dir = mkdtempSync(join(tmpdir(), 'mma-claim-field-'));
  try {
    return fn(InitiativeRecordStore.open({ dbPath: join(dir, "initiatives.db") }));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

/** A product → initiative → task chain, returning the task's uuid. */
function seedTask(store: InitiativeRecordStore): string {
  const product = store.execute({
    operation: 'product_create',
    input: { name: 'Claim Field', slug: 'claim-field' },
    expected_revision: 0,
    provenance: DISTINCT,
  }) as { uuid: string };
  const initiative = store.execute({
    operation: 'initiative_create',
    input: { product_id: product.uuid, title: 'T', goal: 'g', status: 'open', outcome: null },
    expected_revision: 0,
    provenance: DISTINCT,
  }) as { uuid: string };
  const task = store.execute({
    operation: 'initiative_task_create',
    input: {
      initiative_id: initiative.uuid,
      title: 'Task',
      goal: 'g',
      status: 'open',
      outcome: null,
      workspace_ids: [],
      resource_ids: [],
    },
    expected_revision: 0,
    provenance: DISTINCT,
  }) as { uuid: string };
  return task.uuid;
}

describe('task ownership uses one identity field end to end', () => {
  it('claim records authorized_by, not actor_id', () => {
    withStore((store) => {
      const uuid = seedTask(store);
      const claimed = store.execute({
        operation: 'initiative_task_claim',
        input: { uuid },
        expected_revision: 0,
        provenance: DISTINCT,
      }) as { claimed_by: string; status: string };

      expect(claimed.status).toBe('claimed');
      expect(
        claimed.claimed_by,
        'claim wrote actor_id; release/complete/execution all read authorized_by',
      ).toBe(DISTINCT.authorized_by);
      expect(claimed.claimed_by).not.toBe(DISTINCT.actor_id);
    });
  });

  it('the claimant can release its own Task', () => {
    withStore((store) => {
      const uuid = seedTask(store);
      store.execute({ operation: 'initiative_task_claim', input: { uuid }, expected_revision: 0, provenance: DISTINCT });
      const released = store.execute({
        operation: 'initiative_task_release',
        input: { uuid },
        expected_revision: 1,
        provenance: DISTINCT,
      }) as { status: string; claimed_by: string | null };

      expect(released.status, 'the caller that claimed it could not release it').toBe('open');
      expect(released.claimed_by).toBeNull();
    });
  });

  it('the claimant can complete its own Task', () => {
    withStore((store) => {
      const uuid = seedTask(store);
      store.execute({ operation: 'initiative_task_claim', input: { uuid }, expected_revision: 0, provenance: DISTINCT });
      const done = store.execute({
        operation: 'initiative_task_complete',
        input: { uuid, outcome: 'succeeded' },
        expected_revision: 1,
        provenance: DISTINCT,
      }) as { status: string; outcome: string };

      expect(done.status).toBe('completed');
      expect(done.outcome).toBe('succeeded');
    });
  });

  it('a DIFFERENT authorized_by still cannot take someone else\'s Task', () => {
    // The fix must not have removed the ownership check — only made it read the field claim writes.
    withStore((store) => {
      const uuid = seedTask(store);
      store.execute({ operation: 'initiative_task_claim', input: { uuid }, expected_revision: 0, provenance: DISTINCT });
      expect(() =>
        store.execute({
          operation: 'initiative_task_release',
          input: { uuid },
          expected_revision: 1,
          provenance: { ...DISTINCT, authorized_by: 'somebody-else' },
        }),
      ).toThrow(/task_claim_conflict/);
    });
  });
});
