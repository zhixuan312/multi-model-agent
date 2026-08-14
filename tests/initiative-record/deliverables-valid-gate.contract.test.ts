import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { InitiativeRecordStore, evaluateLifecycleGate, type LifecycleContract, type Satisfier } from '../../packages/core/src/initiative-record/index.js';

const provenance = { actor_type: 'human', actor_id: 'u1', interface: 'test', initiated_by: 'u1', authorized_by: 'u1', timestamp: '2026-08-14T00:00:00.000Z', source: 'test' };
const SATISFIERS = ['manual', 'requirements_exist', 'acceptance_criteria_exist', 'decisions_settled', 'deliverables_valid'] as const;
type Equal<Left, Right> = [Left] extends [Right] ? ([Right] extends [Left] ? true : false) : false;
const exactSatisfierVocabulary: Equal<Satisfier, (typeof SATISFIERS)[number]> = true;
const contract: LifecycleContract = {
  id: 'test@1',
  phases: { discover: { required: [] }, refine: { required: [] }, design: { required: [] }, execute: { required: [] }, verify: { required: [] }, deliver: { required: [{ key: 'delivery_confirmed', satisfier: 'manual' }, { key: 'deliverables_valid', satisfier: 'deliverables_valid' }] } },
};

describe('SPEC-007 deliverables_valid satisfier', () => {
  it('is green only for valid or human-approved Deliverables and does not require an output bundle', () => {
    const base = { contract, phase: 'deliver' as const, requirements: [], acceptanceCriteria: [], decisions: [], events: [] };
    expect(evaluateLifecycleGate({ ...base, deliverableValidationStates: [] }).missing.map((item) => item.establishment.key)).toEqual(['delivery_confirmed']);
    expect(evaluateLifecycleGate({ ...base, deliverableValidationStates: ['valid', 'human_approved'] }).missing.map((item) => item.establishment.key)).toEqual(['delivery_confirmed']);
    expect(evaluateLifecycleGate({ ...base, deliverableValidationStates: ['valid', 'invalid'] }).missing.map((item) => item.establishment.key)).toEqual(['delivery_confirmed', 'deliverables_valid']);
    expect(evaluateLifecycleGate({ ...base, deliverableValidationStates: ['pending'] }).missing.map((item) => item.establishment.key)).toEqual(['delivery_confirmed', 'deliverables_valid']);
  });

  it('evaluates every closed Satisfier value without error, including the new deliverables_valid literal', () => {
    // The type-level equality rejects both an omitted new literal and any accidental
    // extra vocabulary member; this runtime assertion keeps the proof visible in Vitest.
    expect(exactSatisfierVocabulary).toBe(true);
    for (const satisfier of SATISFIERS) {
      const oneKey: LifecycleContract = { ...contract, phases: { ...contract.phases, deliver: { required: [{ key: 'x', satisfier }] } } };
      const result = evaluateLifecycleGate({ contract: oneKey, phase: 'deliver', requirements: [], acceptanceCriteria: [], decisions: [], events: [], deliverableValidationStates: [] });
      expect(['green', 'red']).toContain(result.status);
    }
  });

  it('reflects the migrated default deliver gate order — delivery_confirmed then deliverables_valid — through a live gate read', () => {
    const dir = mkdtempSync(join(tmpdir(), 'mma-deliverables-gate-seed-'));
    try {
      const store = InitiativeRecordStore.open({ dbPath: join(dir, 'initiatives.db') });
      const product = store.execute({ operation: 'product_create', input: { name: 'P', slug: 'p' }, expected_revision: 0, provenance }) as { uuid: string };
      const initiative = store.execute({ operation: 'initiative_create', input: { product_id: product.uuid, title: 'I', goal: 'G', status: 'open', outcome: null }, expected_revision: 0, provenance }) as { uuid: string };
      store.execute({ operation: 'deliverable_define', input: { initiative_id: initiative.uuid, target_type: 'runnable-prototype', delivery_contract: 'runnable-prototype@1' }, expected_revision: 0, provenance });
      const resume = store.getLifecycleResumeBlock({ uuid: initiative.uuid });
      const deliverGate = resume.phases.find((entry) => entry.phase === 'deliver')!.gate;
      expect(deliverGate.status).toBe('red');
      expect(deliverGate.missing.map((item) => item.establishment)).toEqual([
        { key: 'delivery_confirmed', satisfier: 'manual' },
        { key: 'deliverables_valid', satisfier: 'deliverables_valid' },
      ]);
      store.close();
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });

  it('does not block deliverable_deliver or another authorized operation while the deliver gate is red', () => {
    const dir = mkdtempSync(join(tmpdir(), 'mma-deliverables-gate-non-enforcement-'));
    try {
      const store = InitiativeRecordStore.open({ dbPath: join(dir, 'initiatives.db') });
      const product = store.execute({ operation: 'product_create', input: { name: 'P', slug: 'p' }, expected_revision: 0, provenance }) as { uuid: string };
      const initiative = store.execute({ operation: 'initiative_create', input: { product_id: product.uuid, title: 'I', goal: 'G', status: 'open', outcome: null }, expected_revision: 0, provenance }) as { uuid: string };
      const deliverable = store.execute({ operation: 'deliverable_define', input: { initiative_id: initiative.uuid, target_type: 'runnable-prototype', delivery_contract: 'runnable-prototype@1' }, expected_revision: 0, provenance }) as { uuid: string; revision: number };
      expect(store.getLifecycleResumeBlock({ uuid: initiative.uuid }).phases.find((entry) => entry.phase === 'deliver')!.gate.status).toBe('red');
      expect(() =>
        store.execute({ operation: 'deliverable_deliver', input: { deliverable_id: deliverable.uuid, delivery_reference: 'ref' }, expected_revision: deliverable.revision, provenance }),
      ).not.toThrow();
      expect(() =>
        store.execute({ operation: 'initiative_phase_enter', input: { initiative: { uuid: initiative.uuid }, phase: 'deliver' }, expected_revision: 0, provenance }),
      ).not.toThrow();
      store.close();
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });
});