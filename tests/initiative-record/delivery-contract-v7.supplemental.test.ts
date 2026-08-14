import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { describe, expect, it } from 'vitest';
import {
  InitiativeRecordStore,
  InvalidRequestError,
  UnknownDeliveryContractError,
  isInitiativeError,
} from '../../packages/core/src/initiative-record/index.js';

describe('SPEC-007 Delivery Contract registry supplemental error coverage', () => {
  it('classifies unknown contracts as Initiative errors', () => {
    const dir = mkdtempSync(join(tmpdir(), 'mma-delivery-contract-error-'));
    try {
      const store = InitiativeRecordStore.open({ dbPath: join(dir, 'initiatives.db') });
      let thrown: unknown;
      try {
        store.getDeliveryContract({ id: 'unknown-contract@1' });
      } catch (error) {
        thrown = error;
      } finally {
        store.close();
      }

      expect(thrown).toBeInstanceOf(UnknownDeliveryContractError);
      expect(isInitiativeError(thrown)).toBe(true);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('rejects malformed JSON and row/declaration identifier mismatches', () => {
    const dir = mkdtempSync(join(tmpdir(), 'mma-delivery-contract-corrupt-'));
    const dbPath = join(dir, 'initiatives.db');
    try {
      const store = InitiativeRecordStore.open({ dbPath });
      store.close();
      const raw = new DatabaseSync(dbPath);
      raw.prepare('UPDATE delivery_contracts SET definition_json = ? WHERE id = ?').run('{', 'runnable-prototype@1');
      raw.close();

      const malformed = InitiativeRecordStore.open({ dbPath });
      expect(() => malformed.getDeliveryContract({ id: 'runnable-prototype@1' })).toThrow(InvalidRequestError);
      malformed.close();

      const corrupt = new DatabaseSync(dbPath);
      corrupt.prepare('UPDATE delivery_contracts SET definition_json = ? WHERE id = ?').run(
        JSON.stringify({
          id: 'runnable-software@1',
          name: 'Runnable prototype',
          version: 1,
          target_type: 'runnable-prototype',
          requires: [],
          verification: [],
        }),
        'runnable-prototype@1',
      );
      corrupt.close();

      const mismatched = InitiativeRecordStore.open({ dbPath });
      expect(() => mismatched.getDeliveryContract({ id: 'runnable-prototype@1' })).toThrow(InvalidRequestError);
      mismatched.close();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
