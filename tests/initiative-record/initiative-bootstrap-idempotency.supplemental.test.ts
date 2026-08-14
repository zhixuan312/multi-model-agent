import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { InitiativeRecordStore } from '../../packages/core/src/initiative-record/index.js';

const provenance = {
  actor_type: 'human', actor_id: 'u1', interface: 'test', initiated_by: 'u1', authorized_by: 'u1',
  timestamp: '2026-08-14T00:00:00.000Z', source: 'test',
};

function request() {
  return {
    operation: 'initiative_bootstrap' as const,
    expected_revision: 0,
    idempotency_key: 'confirmed-intake',
    provenance,
    input: {
      product: { create: { name: 'New Product', slug: 'new-product' } },
      workspaces: [{ workspace_key: 'primary', role: 'creates' as const, create: { name: 'New Workspace', slug: 'new-workspace', description: 'A future repository.' } }],
      resources: [],
      initiative: { title: 'Confirmed intake', goal: 'Create the product outcome.', status: 'open' as const, outcome: null },
    },
  };
}

describe('initiative_bootstrap idempotency (supplemental)', () => {
  it('replays the original complete result without creating another record or Event', () => {
    const dir = mkdtempSync(join(tmpdir(), 'mma-bootstrap-idempotency-'));
    try {
      const store = InitiativeRecordStore.open({ dbPath: join(dir, 'initiatives.db') });
      const first = store.execute(request());
      const eventCount = store.listEvents().length;

      expect(store.execute(request())).toEqual(first);
      expect(store.listInitiatives({}).map((initiative) => initiative.uuid)).toEqual([(first as { uuid: string }).uuid]);
      expect(store.listEvents()).toHaveLength(eventCount);
      store.close();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
