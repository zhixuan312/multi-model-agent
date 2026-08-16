import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { InitiativeRecordStore } from '../../packages/core/src/initiative-record/index.js';

const provenance = { actor_type: 'agent', actor_id: 'host-a', interface: 'mcp', initiated_by: 'host-a', authorized_by: 'host-a', timestamp: '2026-08-13T00:00:00.000Z', source: 'test' };
const asHost = (id: string) => ({ ...provenance, actor_id: id, initiated_by: id, authorized_by: id });
const asHuman = { ...provenance, actor_type: 'human', actor_id: 'maintainer', initiated_by: 'maintainer', authorized_by: 'maintainer' };

describe('Task claim operations', () => {
  it('enforces claim ownership, transitions, revisions, idempotent replay, and the human release override', () => {
    const dir = mkdtempSync(join(tmpdir(), 'mma-task-claim-'));
    const store = InitiativeRecordStore.open({ dbPath: join(dir, 'initiatives.db') });
    try {
      const product = store.execute({ operation: 'product_create', input: { name: 'MMA', slug: 'mma' }, expected_revision: 0, provenance }) as { uuid: string };
      const initiative = store.execute({ operation: 'initiative_create', input: { product_id: product.uuid, title: 'I', goal: 'G', status: 'open', outcome: null }, expected_revision: 0, provenance }) as { uuid: string };
      const task = store.execute({ operation: 'initiative_task_create', input: { initiative_id: initiative.uuid, title: 'T', goal: 'G', status: 'open', outcome: null, workspace_ids: [], resource_ids: [] }, expected_revision: 0, provenance }) as { uuid: string };
      const claimed = store.execute({ operation: 'initiative_task_claim', input: { uuid: task.uuid }, expected_revision: 0, provenance });
      expect(claimed).toMatchObject({ status: 'claimed', claimed_by: 'host-a', revision: 1 });
      expect(() => store.execute({ operation: 'initiative_task_complete', input: { uuid: task.uuid, outcome: 'succeeded' }, expected_revision: 1, provenance: asHost('host-b') })).toThrow(/task_claim_conflict/);
      const executionRequest = { operation: 'initiative_task_execution', input: { uuid: task.uuid, execution_ref: 'execution-1', transition: 'in_progress' }, expected_revision: 1, idempotency_key: 'same-ref', provenance };
      const running = store.execute(executionRequest);
      expect(running).toMatchObject({ status: 'in_progress', executionRefs: ['execution-1'], revision: 2 });
      const replay = store.execute(executionRequest);
      expect(replay).toMatchObject({ executionRefs: ['execution-1'], revision: 2 });
      expect(() => store.execute({ operation: 'initiative_task_claim', input: { uuid: task.uuid }, expected_revision: 2, provenance })).toThrow(/task_not_claimable/);
      expect(() => store.execute({ operation: 'initiative_task_release', input: { uuid: task.uuid }, expected_revision: 2, provenance: asHost('host-b') })).toThrow(/task_claim_conflict/);
      const released = store.execute({ operation: 'initiative_task_release', input: { uuid: task.uuid }, expected_revision: 2, provenance: asHuman });
      expect(released).toMatchObject({ status: 'open', claimed_by: null, revision: 3 });
    } finally { store.close(); rmSync(dir, { recursive: true, force: true }); }
  });
});