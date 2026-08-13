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
import { InitiativeRecordRuntime } from '../../packages/server/src/application/initiative-record-runtime.js';

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
      // Existing-data compatibility (spec success metric): the migrated (pre-existing) Initiative
      // must read back correctly through the real runtime read path, not just the raw table.
      const runtime = InitiativeRecordRuntime.open({ stateDir: dir });
      try {
        const lifecycle = runtime.initiativeGateStatus({ initiative: { uuid: initiativeId } });
        expect(lifecycle).toMatchObject({ focus_phase: null });
        expect(lifecycle.phases.map((entry) => [entry.phase, entry.state])).toEqual([['discover', 'not_started'], ['refine', 'not_started'], ['design', 'not_started'], ['execute', 'not_started'], ['verify', 'not_started'], ['deliver', 'not_started']]);
      } finally { runtime.close(); }
      // Sorted-array equality, not Set equality: a Set collapses an accidental
      // duplicate entry, so only a length-preserving comparison catches one.
      expect([...INITIATIVE_OPERATIONS].sort()).toEqual([...new Set(['product_create', 'product_get', 'product_list', 'workspace_create', 'workspace_get', 'workspace_list', 'resource_register', 'resource_list', 'initiative_create', 'initiative_get', 'initiative_list', 'initiative_status', 'initiative_resume', 'initiative_link_workspace', 'initiative_relate', 'initiative_relations', 'initiative_task_create', 'initiative_task_get', 'initiative_task_list', 'initiative_task_claim', 'initiative_task_release', 'initiative_task_complete', 'initiative_task_execution', 'artifact_register', 'artifact_get', 'requirement_add', 'requirement_get', 'requirement_list', 'acceptance_criterion_add', 'acceptance_criterion_get', 'acceptance_criterion_list', 'decision_record', 'decision_supersede', 'decision_get', 'decision_list', 'evidence_add', 'evidence_get', 'evidence_list', 'evidence_link', 'evidence_links_list', 'risk_add', 'risk_status', 'risk_get', 'risk_list', 'verification_record', 'verification_get', 'verification_list', 'initiative_phase_enter', 'initiative_phase_satisfy', 'initiative_phase_reopen', 'initiative_phase_skip', 'initiative_focus_set', 'initiative_set_lifecycle_contract', 'initiative_gate_status'])].sort());
      expect(INITIATIVE_EVENT_PAYLOAD_KEYS.phase_entered).toEqual(['phase', 'previous_state', 'new_state']);
      expect(INITIATIVE_EVENT_PAYLOAD_KEYS.phase_satisfied).toEqual(['phase', 'previous_state', 'new_state', 'asserted', 'gate_snapshot']);
      expect(INITIATIVE_EVENT_PAYLOAD_KEYS.phase_reopened).toEqual(['phase', 'previous_state', 'new_state', 'reason']);
      expect(INITIATIVE_EVENT_PAYLOAD_KEYS.phase_skipped).toEqual(['phase', 'previous_state', 'new_state', 'reason']);
      expect(INITIATIVE_EVENT_PAYLOAD_KEYS.focus_changed).toEqual(['phase', 'previous_focus_phase', 'new_focus_phase', 'gate_snapshot']);
      expect(INITIATIVE_EVENT_PAYLOAD_KEYS.lifecycle_contract_set).toEqual(['previous_lifecycle_contract', 'new_lifecycle_contract']);
      expect(initiativeOperationRequestSchema.safeParse({ operation: 'initiative_phase_satisfy', input: { initiative: { uuid: initiativeId }, phase: 'discover', asserted: ['problem_framed'] }, expected_revision: 0, provenance }).success).toBe(true);
      expect(initiativeOperationRequestSchema.safeParse({ operation: 'initiative_set_lifecycle_contract', input: { initiative: { uuid: initiativeId }, lifecycle_contract: 'Default@0' }, expected_revision: 0, provenance }).success).toBe(false);
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });
});
