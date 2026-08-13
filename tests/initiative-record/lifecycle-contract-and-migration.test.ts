import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { describe, expect, it } from 'vitest';
import {
  INITIATIVE_EVENT_PAYLOAD_KEYS,
  INITIATIVE_OPERATIONS,
  InitiativeRecordStore,
  initiativeOperationRequestSchema,
  runInitiativeMigrations,
} from '../../packages/core/src/initiative-record/index.js';

const provenance = { actor_type: 'agent', actor_id: 'planner', interface: 'test', initiated_by: 'planner', authorized_by: 'planner', timestamp: '2026-08-13T00:00:00.000Z', source: 'test' };

describe('Lifecycle data contract and v4 migration', () => {
  it('seeds the frozen contract, validates the new boundary, and upgrades v3 without phase-row backfill', () => {
    const dir = mkdtempSync(join(tmpdir(), 'mma-lifecycle-v4-'));
    const dbPath = join(dir, 'initiatives.db');
    try {
      const store = InitiativeRecordStore.open({ dbPath });
      let initiativeId = '';
      try {
        const product = store.execute({ operation: 'product_create', input: { name: 'MMA', slug: 'mma-lifecycle-v4' }, expected_revision: 0, provenance }) as { uuid: string };
        const initiative = store.execute({ operation: 'initiative_create', input: { product_id: product.uuid, title: 'I', goal: 'G', status: 'open', outcome: null }, expected_revision: 0, provenance }) as { uuid: string; focus_phase: string | null; lifecycle_contract: string | null };
        initiativeId = initiative.uuid;
        expect(initiative).toMatchObject({ focus_phase: null, lifecycle_contract: 'default-sdl@1' });
      } finally { store.close(); }
      const raw = new DatabaseSync(dbPath);
      expect(raw.prepare("SELECT definition_json, is_builtin FROM lifecycle_contracts WHERE id = 'default-sdl@1'").get()).toMatchObject({ is_builtin: 1 });
      expect(raw.prepare('SELECT COUNT(*) AS count FROM phase_records').get()).toMatchObject({ count: 0 });
      raw.exec('ALTER TABLE initiatives DROP COLUMN focus_phase');
      raw.exec('ALTER TABLE initiatives DROP COLUMN lifecycle_contract');
      raw.exec('DROP TABLE lifecycle_contracts');
      raw.exec('DROP TABLE phase_records');
      raw.exec('PRAGMA user_version = 3');
      raw.close();
      runInitiativeMigrations({ dbPath });
      const upgraded = new DatabaseSync(dbPath);
      expect(upgraded.prepare('PRAGMA user_version').get()).toMatchObject({ user_version: 4 });
      expect(upgraded.prepare("SELECT COUNT(*) AS count FROM phase_records WHERE initiative_id = ?").get(initiativeId)).toMatchObject({ count: 0 });
      expect(upgraded.prepare("SELECT id FROM lifecycle_contracts WHERE id = 'default-sdl@1'").get()).toEqual({ id: 'default-sdl@1' });
      upgraded.close();
      expect(INITIATIVE_OPERATIONS).toEqual(expect.arrayContaining(['initiative_phase_enter', 'initiative_phase_satisfy', 'initiative_phase_reopen', 'initiative_phase_skip', 'initiative_focus_set', 'initiative_set_lifecycle_contract', 'initiative_gate_status']));
      expect(INITIATIVE_EVENT_PAYLOAD_KEYS.phase_satisfied).toEqual(['phase', 'previous_state', 'new_state', 'asserted', 'gate_snapshot']);
      expect(INITIATIVE_EVENT_PAYLOAD_KEYS.focus_changed).toEqual(['phase', 'previous_focus_phase', 'new_focus_phase', 'gate_snapshot']);
      expect(initiativeOperationRequestSchema.safeParse({ operation: 'initiative_phase_satisfy', input: { initiative: { uuid: initiativeId }, phase: 'discover', asserted: ['problem_framed'] }, expected_revision: 0, provenance }).success).toBe(true);
      expect(initiativeOperationRequestSchema.safeParse({ operation: 'initiative_set_lifecycle_contract', input: { initiative: { uuid: initiativeId }, lifecycle_contract: 'Default@0' }, expected_revision: 0, provenance }).success).toBe(false);
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });
});