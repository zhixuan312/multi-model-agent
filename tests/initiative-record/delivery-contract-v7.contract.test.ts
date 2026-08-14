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

// The pinned v1 catalog (SPEC-007 "Data model"), asserted field-for-field per contract so a
// regression in any single field — not just `id` or `requires` — fails this test.
const PINNED_CONTRACTS = [
  {
    id: 'runnable-prototype@1',
    name: 'Runnable prototype',
    version: 1,
    target_type: 'runnable-prototype',
    requires: ['executable_prototype', 'sample_data', 'usage_instructions', 'known_limitations', 'acceptance_evidence'],
    verification: ['starts_locally', 'sample_flow_passed', 'business_user_reviewed'],
  },
  {
    id: 'runnable-software@1',
    name: 'Runnable software',
    version: 1,
    target_type: 'runnable-software',
    requires: ['source_changes', 'run_instructions', 'successful_build', 'automated_checks', 'runnable_preview'],
    verification: ['build_passed', 'tests_passed', 'primary_user_flow_passed'],
  },
];

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
      expect(INITIATIVE_SCHEMA_VERSION).toBe(8);
      expect(store.listDeliveryContracts()).toEqual(PINNED_CONTRACTS);
      for (const pinned of PINNED_CONTRACTS) {
        expect(store.getDeliveryContract({ id: pinned.id })).toEqual(pinned);
      }
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
