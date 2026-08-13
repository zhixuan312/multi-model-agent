import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { InitiativeRecordStore } from '../../packages/core/src/initiative-record/index.js';

const provenance = { actor_type: 'agent', actor_id: 'host-a', interface: 'test', initiated_by: 'host-a', authorized_by: 'host-a', timestamp: '2026-08-13T00:00:00.000Z', source: 'test' };

describe('Lifecycle store mutations', () => {
  it('enforces transitions, revision/idempotency, reasons, and advisory snapshots', () => {
    const dir = mkdtempSync(join(tmpdir(), 'mma-lifecycle-store-'));
    const store = InitiativeRecordStore.open({ dbPath: join(dir, 'initiatives.db') });
    try {
      const product = store.execute({ operation: 'product_create', input: { name: 'MMA', slug: 'mma-lifecycle-store' }, expected_revision: 0, provenance }) as { uuid: string };
      const initiative = store.execute({ operation: 'initiative_create', input: { product_id: product.uuid, title: 'I', goal: 'G', status: 'open', outcome: null }, expected_revision: 0, provenance }) as { uuid: string };
      expect(() => store.execute({ operation: 'initiative_phase_satisfy', input: { initiative: { uuid: initiative.uuid }, phase: 'discover' }, expected_revision: 0, provenance })).toThrow(/invalid_phase_transition/);
      store.execute({ operation: 'initiative_phase_enter', input: { initiative: { uuid: initiative.uuid }, phase: 'discover' }, expected_revision: 0, idempotency_key: 'discover-enter', provenance });
      const replay = store.execute({ operation: 'initiative_phase_enter', input: { initiative: { uuid: initiative.uuid }, phase: 'discover' }, expected_revision: 0, idempotency_key: 'discover-enter', provenance });
      expect(replay).toBeDefined();
      const afterEnter = store.getInitiative({ uuid: initiative.uuid });
      expect(afterEnter.revision).toBe(1);
      const satisfied = store.execute({ operation: 'initiative_phase_satisfy', input: { initiative: { uuid: initiative.uuid }, phase: 'discover', asserted: ['problem_framed'] }, expected_revision: 1, provenance }) as { state: string };
      expect(satisfied).toMatchObject({ state: 'satisfied' });
      expect(() => store.execute({ operation: 'initiative_phase_reopen', input: { initiative: { uuid: initiative.uuid }, phase: 'discover', reason: '' }, expected_revision: 2, provenance })).toThrow(/invalid_request/);
      store.execute({ operation: 'initiative_phase_reopen', input: { initiative: { uuid: initiative.uuid }, phase: 'discover', reason: 'new finding' }, expected_revision: 2, provenance });
      store.execute({ operation: 'initiative_phase_enter', input: { initiative: { uuid: initiative.uuid }, phase: 'design' }, expected_revision: 3, provenance });
      store.execute({ operation: 'initiative_phase_skip', input: { initiative: { uuid: initiative.uuid }, phase: 'design', reason: 'not needed' }, expected_revision: 4, provenance });
      store.execute({ operation: 'initiative_focus_set', input: { initiative: { uuid: initiative.uuid }, phase: 'refine' }, expected_revision: 5, provenance });
      const events = store.listEvents().filter((event) => event.initiative_id === initiative.uuid);
      expect(events.map((event) => event.event_type)).toEqual(expect.arrayContaining(['phase_entered', 'phase_satisfied', 'phase_reopened', 'phase_skipped', 'focus_changed']));
      expect(events.find((event) => event.event_type === 'phase_satisfied')?.payload).toMatchObject({ asserted: ['problem_framed'], gate_snapshot: { status: 'green' } });
      expect(events.find((event) => event.event_type === 'focus_changed')?.payload).toMatchObject({ phase: 'refine', gate_snapshot: { status: 'red' } });
    } finally { store.close(); rmSync(dir, { recursive: true, force: true }); }
  });

  it('enforces the complete transition matrix: every operation x source state', () => {
    const dir = mkdtempSync(join(tmpdir(), 'mma-lifecycle-matrix-'));
    const store = InitiativeRecordStore.open({ dbPath: join(dir, 'initiatives.db') });
    const LEGAL: Record<string, readonly string[]> = {
      initiative_phase_enter: ['not_started', 'reopened', 'skipped', 'satisfied'],
      initiative_phase_satisfy: ['active', 'reopened'],
      initiative_phase_reopen: ['satisfied', 'skipped'],
      initiative_phase_skip: ['not_started', 'active'],
    };
    const STATES = ['not_started', 'active', 'satisfied', 'reopened', 'skipped'] as const;
    const EXTRA: Record<string, object> = { initiative_phase_reopen: { reason: 'matrix' }, initiative_phase_skip: { reason: 'matrix' } };
    try {
      const product = store.execute({ operation: 'product_create', input: { name: 'MMA', slug: 'mma-lifecycle-matrix' }, expected_revision: 0, provenance }) as { uuid: string };
      let n = 0;
      for (const operation of Object.keys(LEGAL)) {
        for (const source of STATES) {
          n += 1;
          const initiative = store.execute({ operation: 'initiative_create', input: { product_id: product.uuid, title: `M${n}`, goal: 'G', status: 'open', outcome: null }, expected_revision: 0, provenance }) as { uuid: string };
          let revision = 0;
          const step = (op: string, extra: object) => { store.execute({ operation: op, input: { initiative: { uuid: initiative.uuid }, phase: 'execute', ...extra }, expected_revision: revision, provenance }); revision += 1; };
          if (source === 'active') step('initiative_phase_enter', {});
          if (source === 'satisfied') { step('initiative_phase_enter', {}); step('initiative_phase_satisfy', {}); }
          if (source === 'reopened') { step('initiative_phase_enter', {}); step('initiative_phase_satisfy', {}); step('initiative_phase_reopen', { reason: 'drive' }); }
          if (source === 'skipped') step('initiative_phase_skip', { reason: 'drive' });
          const attempt = () => store.execute({ operation, input: { initiative: { uuid: initiative.uuid }, phase: 'execute', ...(EXTRA[operation] ?? {}) }, expected_revision: revision, provenance });
          if (LEGAL[operation].includes(source)) {
            expect(attempt(), `${operation} from ${source} must succeed`).toBeDefined();
          } else {
            expect(attempt, `${operation} from ${source} must reject`).toThrow(/invalid_phase_transition/);
            const unchanged = store.getInitiative({ uuid: initiative.uuid });
            expect(unchanged.revision, `${operation} from ${source} must not write`).toBe(revision);
          }
        }
      }
    } finally { store.close(); rmSync(dir, { recursive: true, force: true }); }
  });
});