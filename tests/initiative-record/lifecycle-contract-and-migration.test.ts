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
      // `InitiativeRecordStore.open` above already ran every migration through the current
      // INITIATIVE_SCHEMA_VERSION, including SPEC-005's v5 addition, SPEC-006's v6 addition, and
      // SPEC-007's v7 addition (all Task I-1). Roll the v5/v6 additions back too before
      // restaging as a v3 database, so the migrations invoked below genuinely re-apply v4, v5,
      // and v6 rather than hitting "duplicate column" on a database that structurally already
      // has them. SPEC-007's v7 tables are additive-only `CREATE TABLE IF NOT EXISTS` /
      // `INSERT OR IGNORE` DDL with no v3/v4 column dependency, so leaving them in place does
      // not affect this check.
      raw.exec('ALTER TABLE tasks DROP COLUMN method');
      raw.exec('DROP TABLE methods');
      raw.exec('PRAGMA user_version = 3');
      raw.close();
      runInitiativeMigrations({ dbPath });
      const upgraded = new DatabaseSync(dbPath);
      // A v3 database upgrades through every pending migration, landing on the current
      // INITIATIVE_SCHEMA_VERSION (SPEC-007 Task I-7 added v8) rather than the v4 this check
      // originally pinned.
      expect(upgraded.prepare('PRAGMA user_version').get()).toMatchObject({ user_version: 8 });
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
      // SPEC-005 (Task I-1) added `method_get`, `method_list`, and `initiative_task_set_method`;
      // SPEC-006 (Task I-2) added `initiative_bootstrap`; SPEC-007 (Task I-3) added
      // `delivery_contract_get`, `delivery_contract_list`, `deliverable_define`, `deliverable_get`,
      // `deliverable_list`, and `deliverable_attach_artifact`; SPEC-007 (Task I-4) added
      // `deliverable_validate` and `deliverable_deliver`; SPEC-007 (Task I-6) added
      // `deliverable_approve` — this check's expected list includes all of them alongside every
      // operation SPEC-001 through SPEC-004 pinned.
      expect([...INITIATIVE_OPERATIONS].sort()).toEqual([...new Set(['product_create', 'product_get', 'product_list', 'workspace_create', 'workspace_get', 'workspace_list', 'resource_register', 'resource_list', 'initiative_create', 'initiative_get', 'initiative_list', 'initiative_status', 'initiative_resume', 'initiative_link_workspace', 'initiative_relate', 'initiative_relations', 'initiative_task_create', 'initiative_task_get', 'initiative_task_list', 'initiative_task_claim', 'initiative_task_release', 'initiative_task_complete', 'initiative_task_execution', 'artifact_register', 'artifact_get', 'requirement_add', 'requirement_get', 'requirement_list', 'acceptance_criterion_add', 'acceptance_criterion_get', 'acceptance_criterion_list', 'decision_record', 'decision_supersede', 'decision_get', 'decision_list', 'evidence_add', 'evidence_get', 'evidence_list', 'evidence_link', 'evidence_links_list', 'risk_add', 'risk_status', 'risk_get', 'risk_list', 'verification_record', 'verification_get', 'verification_list', 'initiative_phase_enter', 'initiative_phase_satisfy', 'initiative_phase_reopen', 'initiative_phase_skip', 'initiative_focus_set', 'initiative_set_lifecycle_contract', 'initiative_gate_status', 'method_get', 'method_list', 'initiative_task_set_method', 'initiative_bootstrap', 'delivery_contract_get', 'delivery_contract_list', 'deliverable_define', 'deliverable_get', 'deliverable_list', 'deliverable_attach_artifact', 'deliverable_validate', 'deliverable_deliver', 'deliverable_approve'])].sort());
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

  it('upgrades the v7 built-in default deliver gate with the advisory deliverables_valid requirement', () => {
    const dir = mkdtempSync(join(tmpdir(), 'mma-lifecycle-v8-'));
    const dbPath = join(dir, 'initiatives.db');
    try {
      const store = InitiativeRecordStore.open({ dbPath });
      store.close();

      const v7 = new DatabaseSync(dbPath);
      v7.prepare("UPDATE lifecycle_contracts SET definition_json = ? WHERE id = 'default-sdl@1'").run(
        JSON.stringify({
          id: 'default-sdl@1',
          phases: {
            discover: { required: [{ key: 'problem_framed', satisfier: 'manual' }] },
            refine: { required: [] },
            design: { required: [] },
            execute: { required: [] },
            verify: { required: [] },
            deliver: { required: [{ key: 'delivery_confirmed', satisfier: 'manual' }] },
          },
        }),
      );
      v7.exec('PRAGMA user_version = 7');
      expect(v7.prepare('PRAGMA user_version').get()).toMatchObject({ user_version: 7 });
      v7.close();

      runInitiativeMigrations({ dbPath });

      const upgraded = new DatabaseSync(dbPath);
      const definition = upgraded.prepare("SELECT definition_json FROM lifecycle_contracts WHERE id = 'default-sdl@1'").get() as { definition_json: string };
      expect(JSON.parse(definition.definition_json).phases.deliver.required).toEqual([
        { key: 'delivery_confirmed', satisfier: 'manual' },
        { key: 'deliverables_valid', satisfier: 'deliverables_valid' },
      ]);
      upgraded.close();
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });
});
