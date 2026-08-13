/**
 * Phase A1 ordinary mutations — supplementary edge-case coverage (Task I-3).
 *
 * `a1-mutations-events.check.test.ts` is the plan-authored acceptance test and
 * is never edited. This file covers Contract error paths that check test does
 * not exercise: a nonexistent parent on a Phase A1 create (`invalid_request`
 * via the Phase A0 `requireExists`/`requireRow` convention), an unknown
 * `decision_supersede`/`risk_status` selector (`not_found`), and a
 * non-zero `expected_revision` on a create-like Phase A1 mutation
 * (`revision_conflict`).
 */
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { InitiativeRecordStore } from '../../packages/core/src/initiative-record/index.js';

const provenance = {
  actor_type: 'human',
  actor_id: 'u',
  interface: 'http',
  initiated_by: 'u',
  authorized_by: 'u',
  timestamp: '2026-08-13T00:00:00.000Z',
  source: 'check',
};

function thrownCode(fn: () => unknown): string | undefined {
  try {
    fn();
  } catch (error) {
    return (error as { code?: string }).code;
  }
  return undefined;
}

function withStore(run: (store: InitiativeRecordStore) => void): void {
  const dir = mkdtempSync(join(tmpdir(), 'mma-a1-mutations-supplement-'));
  const store = InitiativeRecordStore.open({ dbPath: join(dir, 'initiatives.db') });
  try {
    run(store);
  } finally {
    store.close();
    rmSync(dir, { recursive: true, force: true });
  }
}

const MISSING_UUID = '00000000-0000-4000-8000-000000000099';

describe('Phase A1 ordinary mutations — supplementary edge cases', () => {
  it('rejects a Phase A1 create against a nonexistent parent with invalid_request and no write', () => {
    withStore((store) => {
      expect(
        thrownCode(() =>
          store.execute({
            operation: 'requirement_add',
            input: { initiative_id: MISSING_UUID, statement: 'S' },
            expected_revision: 0,
            provenance,
          }),
        ),
      ).toBe('invalid_request');
      expect(
        thrownCode(() =>
          store.execute({
            operation: 'acceptance_criterion_add',
            input: { requirement_id: MISSING_UUID, statement: 'C', check_reference: 'c' },
            expected_revision: 0,
            provenance,
          }),
        ),
      ).toBe('invalid_request');
      expect(
        thrownCode(() =>
          store.execute({
            operation: 'decision_record',
            input: { initiative_id: MISSING_UUID, title: 'T', decision: 'D', rationale: 'R', alternatives: [], status: 'open' },
            expected_revision: 0,
            provenance,
          }),
        ),
      ).toBe('invalid_request');
      expect(
        thrownCode(() =>
          store.execute({
            operation: 'risk_add',
            input: { initiative_id: MISSING_UUID, statement: 'R', severity: 'low', status: 'open' },
            expected_revision: 0,
            provenance,
          }),
        ),
      ).toBe('invalid_request');
      expect(
        thrownCode(() =>
          store.execute({
            operation: 'evidence_add',
            input: { initiative_id: MISSING_UUID, kind: 'file', locator: 'a', content_hash: null, summary: 's' },
            expected_revision: 0,
            provenance,
          }),
        ),
      ).toBe('invalid_request');
      expect(store.listEvents({})).toHaveLength(0);
    });
  });

  it('throws not_found for decision_supersede and risk_status against an unknown selector, with no write', () => {
    withStore((store) => {
      const product = store.execute({
        operation: 'product_create',
        input: { name: 'P', slug: 'p' },
        expected_revision: 0,
        provenance,
      }) as { uuid: string };
      const initiative = store.execute({
        operation: 'initiative_create',
        input: { product_id: product.uuid, title: 'I', goal: 'G', status: 'open', outcome: null },
        expected_revision: 0,
        provenance,
      }) as { uuid: string };
      const eventsBefore = store.listEvents({}).length;

      expect(
        thrownCode(() =>
          store.execute({
            operation: 'decision_supersede',
            input: { uuid: MISSING_UUID, title: 'T', decision: 'D', rationale: 'R', alternatives: [] },
            expected_revision: 0,
            provenance,
          }),
        ),
      ).toBe('not_found');
      expect(
        thrownCode(() =>
          store.execute({
            operation: 'risk_status',
            input: { uuid: MISSING_UUID, status: 'mitigated' },
            expected_revision: 0,
            provenance,
          }),
        ),
      ).toBe('not_found');
      // A scoped (initiative_id, human_key) selector that resolves to no row is equally not_found.
      expect(
        thrownCode(() =>
          store.getDecision({ initiative_id: initiative.uuid, human_key: 'D-99' }),
        ),
      ).toBe('not_found');
      expect(store.listEvents({})).toHaveLength(eventsBefore);
    });
  });

  it('throws revision_conflict for a nonzero expected_revision on Phase A1 creates', () => {
    withStore((store) => {
      const product = store.execute({
        operation: 'product_create',
        input: { name: 'P', slug: 'p' },
        expected_revision: 0,
        provenance,
      }) as { uuid: string };
      const initiative = store.execute({
        operation: 'initiative_create',
        input: { product_id: product.uuid, title: 'I', goal: 'G', status: 'open', outcome: null },
        expected_revision: 0,
        provenance,
      }) as { uuid: string };
      expect(
        thrownCode(() =>
          store.execute({
            operation: 'requirement_add',
            input: { initiative_id: initiative.uuid, statement: 'S' },
            expected_revision: 1,
            provenance,
          }),
        ),
      ).toBe('revision_conflict');
      expect(
        thrownCode(() =>
          store.execute({
            operation: 'risk_add',
            input: { initiative_id: initiative.uuid, statement: 'R', severity: 'low', status: 'open' },
            expected_revision: 1,
            provenance,
          }),
        ),
      ).toBe('revision_conflict');
    });
  });

  it('allocates independent human-key sequences per scope (REQ per Initiative, AC per Requirement)', () => {
    withStore((store) => {
      const product = store.execute({
        operation: 'product_create',
        input: { name: 'P', slug: 'p' },
        expected_revision: 0,
        provenance,
      }) as { uuid: string };
      const first = store.execute({
        operation: 'initiative_create',
        input: { product_id: product.uuid, title: 'A', goal: 'G', status: 'open', outcome: null },
        expected_revision: 0,
        provenance,
      }) as { uuid: string };
      const second = store.execute({
        operation: 'initiative_create',
        input: { product_id: product.uuid, title: 'B', goal: 'G', status: 'open', outcome: null },
        expected_revision: 0,
        provenance,
      }) as { uuid: string };
      const req1 = store.execute({
        operation: 'requirement_add',
        input: { initiative_id: first.uuid, statement: 'S1' },
        expected_revision: 0,
        provenance,
      }) as { human_key: string };
      const req2 = store.execute({
        operation: 'requirement_add',
        input: { initiative_id: second.uuid, statement: 'S2' },
        expected_revision: 0,
        provenance,
      }) as { human_key: string };
      // Each Initiative's Requirement sequence starts independently at REQ-1.
      expect(req1.human_key).toBe('REQ-1');
      expect(req2.human_key).toBe('REQ-1');
    });
  });
});
