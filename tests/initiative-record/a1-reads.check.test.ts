import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { InitiativeRecordStore } from '../../packages/core/src/initiative-record/index.js';

const provenance = { actor_type: 'human', actor_id: 'u', interface: 'http', initiated_by: 'u', authorized_by: 'u', timestamp: '2026-08-13T00:00:00.000Z', source: 'check' };
function caughtCode(fn: () => unknown): string | undefined { try { fn(); } catch (error) { return (error as { code?: string }).code; } return undefined; }

describe('Phase A1 reads', () => {
  it('uses scoped identities, never returns null from get, and applies frozen list ordering', () => {
    const dir = mkdtempSync(join(tmpdir(), 'mma-a1-reads-'));
    const store = InitiativeRecordStore.open({ dbPath: join(dir, 'initiatives.db') });
    try {
      const product = store.execute({ operation: 'product_create', input: { name: 'P', slug: 'p' }, expected_revision: 0, provenance }) as { uuid: string };
      const initiative = store.execute({ operation: 'initiative_create', input: { product_id: product.uuid, title: 'I', goal: 'G', status: 'open', outcome: null }, expected_revision: 0, provenance }) as { uuid: string };
      const requirement = store.execute({ operation: 'requirement_add', input: { initiative_id: initiative.uuid, statement: 'R' }, expected_revision: 0, provenance }) as { uuid: string; human_key: string };
      const criterion = store.execute({ operation: 'acceptance_criterion_add', input: { requirement_id: requirement.uuid, statement: 'C', check_reference: 'c' }, expected_revision: 0, provenance }) as { uuid: string; human_key: string };
      const open = store.execute({ operation: 'decision_record', input: { initiative_id: initiative.uuid, title: 'O', decision: 'd', rationale: 'r', alternatives: [], status: 'open' }, expected_revision: 0, provenance }) as { uuid: string };
      const decided = store.execute({ operation: 'decision_record', input: { initiative_id: initiative.uuid, title: 'D', decision: 'd', rationale: 'r', alternatives: [], status: 'decided' }, expected_revision: 0, provenance }) as { uuid: string };
      expect(store.getRequirement({ initiative_id: initiative.uuid, human_key: requirement.human_key })).toMatchObject({ uuid: requirement.uuid });
      expect(store.getAcceptanceCriterion({ requirement_id: requirement.uuid, human_key: criterion.human_key })).not.toBeNull();
      expect(store.listDecisions({ initiative_id: initiative.uuid }).map((decision) => decision.uuid)).toEqual([open.uuid, decided.uuid]);
      expect(store.listVerificationRuns({ initiative_id: initiative.uuid })).toEqual([]);
      expect(caughtCode(() => store.getEvidence({ uuid: '00000000-0000-4000-8000-000000000099' }))).toBe('not_found');
    } finally { store.close(); rmSync(dir, { recursive: true, force: true }); }
  });
});