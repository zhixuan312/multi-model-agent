import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { describe, expect, it } from 'vitest';
import { InitiativeRecordStore } from '../../packages/core/src/initiative-record/index.js';
import { InitiativeRecordRuntime } from '../../packages/server/src/application/initiative-record-runtime.js';

const provenance = { actor_type: 'agent', actor_id: 'host-a', interface: 'test', initiated_by: 'host-a', authorized_by: 'host-a', timestamp: '2026-08-13T00:00:00.000Z', source: 'test' };

describe('Lifecycle reads', () => {
  it('synthesizes six stable records, keeps existing resume fields, and does not write during a gate read', () => {
    const dir = mkdtempSync(join(tmpdir(), 'mma-lifecycle-read-'));
    const dbPath = join(dir, 'initiatives.db');
    // Seed through the core store directly: `initiative_create.lifecycle_contract` accepts
    // only a registered id or omission (never `null` — FR-7 reserves an explicit `null` for
    // `initiative_set_lifecycle_contract`), and that contract-clearing mutation is a Task I-2
    // store capability that does not require Task I-5's runtime execute() allowlist update.
    let productUuid = '';
    let initiativeUuid = '';
    const seed = InitiativeRecordStore.open({ dbPath });
    try {
      const product = seed.execute({ operation: 'product_create', input: { name: 'MMA', slug: 'mma-lifecycle-read' }, expected_revision: 0, provenance }) as { uuid: string };
      const initiative = seed.execute({ operation: 'initiative_create', input: { product_id: product.uuid, title: 'I', goal: 'G', status: 'open', outcome: null }, expected_revision: 0, provenance }) as { uuid: string; revision: number };
      seed.execute({ operation: 'initiative_set_lifecycle_contract', input: { initiative: { uuid: initiative.uuid }, lifecycle_contract: null }, expected_revision: initiative.revision, provenance });
      productUuid = product.uuid;
      initiativeUuid = initiative.uuid;
    } finally { seed.close(); }
    const runtime = InitiativeRecordRuntime.open({ stateDir: dir });
    try {
      // Full row content, not COUNT(*): a gate read that UPDATED a row in place
      // (touching initiatives.updated_at, rewriting a phase_records row) leaves every
      // count identical, so counts alone cannot prove FR-8 purity.
      const snapshotCounts = (db: DatabaseSync) => ({
        phase_records: JSON.stringify(db.prepare('SELECT * FROM phase_records ORDER BY initiative_id, phase').all()),
        events: JSON.stringify(db.prepare('SELECT * FROM events ORDER BY event_sequence').all()),
        initiatives: JSON.stringify(db.prepare('SELECT * FROM initiatives ORDER BY uuid').all()),
        lifecycle_contracts: JSON.stringify(db.prepare('SELECT * FROM lifecycle_contracts ORDER BY id').all()),
      });
      const beforeDb = new DatabaseSync(dbPath);
      const before = snapshotCounts(beforeDb);
      beforeDb.close();
      const lifecycle = runtime.initiativeGateStatus({ initiative: { uuid: initiativeUuid } });
      const afterDb = new DatabaseSync(dbPath);
      const after = snapshotCounts(afterDb);
      afterDb.close();
      expect(after).toEqual(before);
      expect(lifecycle).toMatchObject({ focus_phase: null, contract: null });
      expect(lifecycle.phases.map((entry) => [entry.phase, entry.state])).toEqual([['discover', 'not_started'], ['refine', 'not_started'], ['design', 'not_started'], ['execute', 'not_started'], ['verify', 'not_started'], ['deliver', 'not_started']]);
      expect(lifecycle.phases.every((entry) => entry.gate.note === 'No lifecycle contract is set.')).toBe(true);
      const resumed = runtime.initiativeResume({ initiative: { uuid: initiativeUuid } });
      expect(resumed).toMatchObject({ initiative: { uuid: initiativeUuid }, product: { uuid: productUuid }, lifecycle });
      expect(resumed).toHaveProperty('counts');
      expect(resumed).toHaveProperty('events');
    } finally { runtime.close(); rmSync(dir, { recursive: true, force: true }); }
  });
});