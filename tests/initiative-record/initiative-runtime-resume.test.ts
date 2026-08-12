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
      expect(Object.keys(response).sort()).toEqual(['artifacts', 'counts', 'events', 'initiative', 'product', 'related_initiatives', 'tasks', 'workspaces']);
      expect(response.initiative.uuid).toBe(initiative.uuid);
      expect(response.product.uuid).toBe(product.uuid);
      expect(response.events).toEqual([...response.events].sort((a, b) => b.event_sequence - a.event_sequence));
      expect(response.counts).toMatchObject({ workspaces: 0, resources: 0, related_initiatives: 0, tasks: 0, artifacts: 0, events_returned: 2, events_total: 2 });
      expect(Object.keys(response.counts.tasks_by_status).sort()).toEqual(['blocked', 'cancelled', 'claimed', 'completed', 'in_progress', 'open']);
      expect(() => runtime.initiativeResume({ initiative: { human_key: initiative.human_key }, event_limit: 0 })).toThrow(/invalid_request/);
    } finally { runtime.close(); rmSync(stateDir, { recursive: true, force: true }); }
  });
});