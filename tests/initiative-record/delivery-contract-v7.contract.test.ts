import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { describe, expect, it } from 'vitest';
import {
  INITIATIVE_SCHEMA_VERSION,
  InitiativeRecordStore,
  runInitiativeMigrations,
} from '../../packages/core/src/initiative-record/index.js';

const IDS = ['runnable-prototype@1', 'runnable-software@1'];

describe('SPEC-007 schema v7 Delivery Contract catalog', () => {
  it('upgrades v6, seeds only the two immutable contracts, and revalidates stored JSON', () => {
    const dir = mkdtempSync(join(tmpdir(), 'mma-delivery-v7-'));
    const dbPath = join(dir, 'initiatives.db');
    try {
      const before = InitiativeRecordStore.open({ dbPath });
      before.close();
      const raw = new DatabaseSync(dbPath);
      raw.exec('DROP TABLE deliverable_delivery_history; DROP TABLE deliverable_artifacts; DROP TABLE deliverables; DROP TABLE delivery_contracts; PRAGMA user_version = 6');
      raw.close();
      runInitiativeMigrations({ dbPath });
      const store = InitiativeRecordStore.open({ dbPath });
      expect(INITIATIVE_SCHEMA_VERSION).toBe(7);
      expect(store.listDeliveryContracts().map((contract) => contract.id)).toEqual(IDS);
      expect(store.getDeliveryContract({ id: 'runnable-prototype@1' }).requires).toEqual([
        'executable_prototype', 'sample_data', 'usage_instructions', 'known_limitations', 'acceptance_evidence',
      ]);
      // `InitiativeError` and `INITIATIVE_ERROR_CTORS` are runtime-only lists: this
      // direct domain failure proves `unknown_delivery_contract` joined both lists.
      expect(() => store.getDeliveryContract({ id: 'not-a-real-contract@1' })).toThrow(/unknown_delivery_contract/i);
      store.close();
      const corrupt = new DatabaseSync(dbPath);
      corrupt.prepare('UPDATE delivery_contracts SET definition_json = ? WHERE id = ?').run('{"id":"runnable-prototype@1","extra":true}', 'runnable-prototype@1');
      corrupt.close();
      const reopened = InitiativeRecordStore.open({ dbPath });
      expect(() => reopened.getDeliveryContract({ id: 'runnable-prototype@1' })).toThrow(/invalid_request/i);
      reopened.close();
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });
});