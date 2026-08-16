import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { InitiativeRecordStore } from '../../packages/core/src/initiative-record/index.js';

const provenance = { actor_type: 'agent', actor_id: 'a1', interface: 'mcp', initiated_by: 'a1', authorized_by: 'h1', timestamp: '2026-08-12T00:00:00.000Z', source: 'manual' };

describe('Initiative mutation contract', () => {
  it('replays an identical idempotent create and never creates a second Event', () => {
    const dir = mkdtempSync(join(tmpdir(), 'mma-initiative-mutation-'));
    const store = InitiativeRecordStore.open({ dbPath: join(dir, 'initiatives.db') });
    try {
      const request = { operation: 'product_create' as const, input: { name: 'MMA', slug: 'mma' }, expected_revision: 0, idempotency_key: 'product-mma', provenance };
      const first = store.execute(request) as { uuid: string };
      const replay = store.execute(request);
      expect(replay).toEqual(first);
      expect(store.listEvents({})).toHaveLength(1);
      expect(store.listEvents({})[0]).toMatchObject({ event_sequence: 1, event_type: 'product_created', payload: { uuid: first.uuid, slug: 'mma' }, actor_id: 'a1', authorized_by: 'h1' });
      expect(() => store.execute({ ...request, input: { name: 'Different', slug: 'mma' } })).toThrow(/invalid_request/);
      expect(store.listEvents({})).toHaveLength(1);
    } finally { store.close(); rmSync(dir, { recursive: true, force: true }); }
  });

  it('returns revision_conflict without a record or Event change', () => {
    const dir = mkdtempSync(join(tmpdir(), 'mma-initiative-revision-'));
    const store = InitiativeRecordStore.open({ dbPath: join(dir, 'initiatives.db') });
    try {
      const product = store.execute({ operation: 'product_create', input: { name: 'MMA', slug: 'mma' }, expected_revision: 0, provenance }) as { uuid: string };
      expect(() => store.execute({ operation: 'initiative_create', input: { product_id: product.uuid, title: 'T', goal: 'G', status: 'open', outcome: null }, expected_revision: 3, provenance })).toThrow(/revision_conflict/);
      expect(store.listEvents({})).toHaveLength(1);
      expect(() => store.execute({ operation: 'initiative_create', input: { product_id: product.uuid, title: 'T', goal: 'G', status: 'closed', outcome: null }, expected_revision: 0, provenance })).toThrow(/invalid_request/);
      expect(store.listEvents({})).toHaveLength(1);
    } finally { store.close(); rmSync(dir, { recursive: true, force: true }); }
  });
});