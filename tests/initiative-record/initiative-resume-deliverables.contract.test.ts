// MMA Next gap-closure (§15: "resume returns deliverable validation states") — GAP 1 regression.
// Before this change, `InitiativeResumeResponse` carried no `deliverables` section and no
// `counts.deliverables_by_validation_state`, even though §15 pins resume as the operation that
// returns "deliverable validation states". This test FAILS against the pre-fix code (the
// response has no `deliverables` key at all) and passes once the additive section/count exist.
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { InitiativeRecordRuntime } from '../../packages/server/src/application/initiative-record-runtime.js';

const provenance = {
  actor_type: 'agent',
  actor_id: 'seed',
  interface: 'test',
  initiated_by: 'seed',
  authorized_by: 'seed',
  timestamp: '2026-08-14T00:00:00.000Z',
  source: 'test',
};

describe('MMA Next gap-closure — initiative_resume Deliverables (GAP 1)', () => {
  it('includes every Deliverable and a validation-state count in the resume payload', () => {
    const stateDir = mkdtempSync(join(tmpdir(), 'mma-resume-deliverables-'));
    try {
      const runtime = InitiativeRecordRuntime.open({ stateDir });
      try {
        const product = runtime.execute({ operation: 'product_create', input: { name: 'P', slug: 'p' }, expected_revision: 0, provenance }) as { uuid: string };
        const initiative = runtime.execute({
          operation: 'initiative_create',
          input: { product_id: product.uuid, title: 'I', goal: 'G', status: 'open', outcome: null },
          expected_revision: 0,
          provenance,
        }) as { uuid: string; human_key: string };
        const deliverable = runtime.execute({
          operation: 'deliverable_define',
          input: { initiative_id: initiative.uuid, target_type: 'runnable-prototype', delivery_contract: 'runnable-prototype@1' },
          expected_revision: 0,
          provenance,
        }) as { uuid: string };

        const resumed = runtime.initiativeResume({ initiative: { uuid: initiative.uuid } });

        expect(resumed.deliverables).toHaveLength(1);
        expect(resumed.deliverables[0]).toMatchObject({
          uuid: deliverable.uuid,
          initiative_id: initiative.uuid,
          target_type: 'runnable-prototype',
          delivery_contract: 'runnable-prototype@1',
          validation_state: 'pending',
          validation_detail: '',
          delivery_reference: null,
        });
        expect(resumed.counts.deliverables_by_validation_state).toEqual({
          pending: 1,
          valid: 0,
          invalid: 0,
          human_approved: 0,
        });
      } finally {
        runtime.close();
      }
    } finally {
      rmSync(stateDir, { recursive: true, force: true });
    }
  });

  it('returns an empty deliverables section and all-zero counts for an Initiative with none', () => {
    const stateDir = mkdtempSync(join(tmpdir(), 'mma-resume-deliverables-empty-'));
    try {
      const runtime = InitiativeRecordRuntime.open({ stateDir });
      try {
        const product = runtime.execute({ operation: 'product_create', input: { name: 'P', slug: 'p' }, expected_revision: 0, provenance }) as { uuid: string };
        const initiative = runtime.execute({
          operation: 'initiative_create',
          input: { product_id: product.uuid, title: 'I', goal: 'G', status: 'open', outcome: null },
          expected_revision: 0,
          provenance,
        }) as { uuid: string };
        const resumed = runtime.initiativeResume({ initiative: { uuid: initiative.uuid } });
        expect(resumed.deliverables).toEqual([]);
        expect(resumed.counts.deliverables_by_validation_state).toEqual({ pending: 0, valid: 0, invalid: 0, human_approved: 0 });
      } finally {
        runtime.close();
      }
    } finally {
      rmSync(stateDir, { recursive: true, force: true });
    }
  });
});
