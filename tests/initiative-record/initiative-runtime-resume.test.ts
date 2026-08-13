import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { InitiativeRecordRuntime } from '../../packages/server/src/application/initiative-record-runtime.js';

const provenance = { actor_type: 'human', actor_id: 'u1', interface: 'http', initiated_by: 'u1', authorized_by: 'u1', timestamp: '2026-08-12T00:00:00.000Z', source: 'manual' };

describe('InitiativeRecordRuntime resume', () => {
  it('returns every pinned section, default event window, ordering, and counts in one response', () => {
    const stateDir = mkdtempSync(join(tmpdir(), 'mma-initiative-runtime-'));
    const runtime = InitiativeRecordRuntime.open({ stateDir });
    try {
      const product = runtime.execute({ operation: 'product_create', input: { name: 'MMA', slug: 'mma' }, expected_revision: 0, provenance });
      const initiative = runtime.execute({ operation: 'initiative_create', input: { product_id: product.uuid, title: 'I', goal: 'G', status: 'open', outcome: null }, expected_revision: 0, provenance });
      const response = runtime.initiativeResume({ initiative: { human_key: initiative.human_key } });
      expect(Object.keys(response).sort()).toEqual(['artifacts', 'counts', 'decisions', 'events', 'evidence', 'initiative', 'product', 'related_initiatives', 'requirements', 'risks', 'tasks', 'verification', 'workspaces']);
      expect(response.initiative.uuid).toBe(initiative.uuid);
      expect(response.product.uuid).toBe(product.uuid);
      expect(response.events).toEqual([...response.events].sort((a, b) => b.event_sequence - a.event_sequence));
      expect(response.requirements).toEqual([]);
      expect(response.decisions).toEqual([]);
      expect(response.risks).toEqual([]);
      expect(response.evidence).toEqual([]);
      expect(response.verification).toEqual([]);
      expect(response.counts).toMatchObject({
        workspaces: 0,
        resources: 0,
        related_initiatives: 0,
        tasks: 0,
        artifacts: 0,
        events_returned: 2,
        events_total: 2,
        requirements: 0,
        acceptance_criteria: 0,
        decisions_open: 0,
        risks_open: 0,
        evidence: 0,
      });
      expect(Object.keys(response.counts.tasks_by_status).sort()).toEqual(['blocked', 'cancelled', 'claimed', 'completed', 'in_progress', 'open']);
      expect(Object.keys(response.counts.verification_by_state).sort()).toEqual(['blocked', 'fail', 'needs_human_review', 'not_applicable', 'pass', 'pending', 'stale', 'superseded']);
      expect(Object.values(response.counts.verification_by_state).every((count) => count === 0)).toBe(true);
      expect(() => runtime.initiativeResume({ initiative: { human_key: initiative.human_key }, event_limit: 0 })).toThrow(/invalid_request/);
    } finally { runtime.close(); rmSync(stateDir, { recursive: true, force: true }); }
  });
});