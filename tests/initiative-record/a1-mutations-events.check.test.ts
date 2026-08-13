import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { InitiativeRecordStore } from '../../packages/core/src/initiative-record/index.js';

const provenance = { actor_type: 'human', actor_id: 'u', interface: 'http', initiated_by: 'u', authorized_by: 'u', timestamp: '2026-08-13T00:00:00.000Z', source: 'check' };
function thrownCode(fn: () => unknown): string | undefined { try { fn(); } catch (error) { return (error as { code?: string }).code; } return undefined; }

describe('Phase A1 ordinary mutations and Events', () => {
  it('applies revisions, scoped keys, supersession, Evidence limits, and exact payload keys', () => {
    const dir = mkdtempSync(join(tmpdir(), 'mma-a1-mutations-'));
    const store = InitiativeRecordStore.open({ dbPath: join(dir, 'initiatives.db') });
    try {
      const product = store.execute({ operation: 'product_create', input: { name: 'P', slug: 'p' }, expected_revision: 0, provenance }) as { uuid: string };
      const initiative = store.execute({ operation: 'initiative_create', input: { product_id: product.uuid, title: 'I', goal: 'G', status: 'open', outcome: null }, expected_revision: 0, provenance }) as { uuid: string };
      const requirement = store.execute({ operation: 'requirement_add', input: { initiative_id: initiative.uuid, statement: 'S' }, expected_revision: 0, provenance }) as { uuid: string; human_key: string };
      const criterion = store.execute({ operation: 'acceptance_criterion_add', input: { requirement_id: requirement.uuid, statement: 'C', check_reference: 'check' }, expected_revision: 0, provenance }) as { human_key: string };
      const oldDecision = store.execute({ operation: 'decision_record', input: { initiative_id: initiative.uuid, title: 'Old', decision: 'old', rationale: 'r', alternatives: ['a'], status: 'open' }, expected_revision: 0, provenance }) as { uuid: string; revision: number };
      const replacement = store.execute({ operation: 'decision_supersede', input: { uuid: oldDecision.uuid, title: 'New', decision: 'new', rationale: 'r', alternatives: ['a'] }, expected_revision: oldDecision.revision, provenance }) as { uuid: string; status: string };
      const evidence = store.execute({ operation: 'evidence_add', input: { initiative_id: initiative.uuid, kind: 'file', locator: 'a', content_hash: 'one', summary: 'one' }, expected_revision: 0, provenance }) as { uuid: string; revision: number };
      const updated = store.execute({ operation: 'evidence_add', input: { initiative_id: initiative.uuid, kind: 'url', locator: 'a', content_hash: 'two', summary: 'two' }, expected_revision: evidence.revision, provenance }) as { uuid: string; revision: number };
      const risk = store.execute({ operation: 'risk_add', input: { initiative_id: initiative.uuid, statement: 'R', severity: 'high', status: 'open' }, expected_revision: 0, provenance }) as { uuid: string; revision: number };
      const changedRisk = store.execute({ operation: 'risk_status', input: { uuid: risk.uuid, status: 'mitigated' }, expected_revision: risk.revision, provenance }) as { status: string };
      expect(requirement.human_key).toBe('REQ-1');
      expect(criterion.human_key).toBe('AC-1');
      expect(replacement.status).toBe('decided');
      expect(store.getDecision({ uuid: oldDecision.uuid })).toMatchObject({ status: 'superseded', superseded_by: replacement.uuid });
      expect(updated).toMatchObject({ uuid: evidence.uuid, revision: evidence.revision + 1 });
      expect(changedRisk.status).toBe('mitigated');
      expect(thrownCode(() => store.execute({ operation: 'evidence_add', input: { initiative_id: initiative.uuid, kind: 'url', locator: 'a', content_hash: 'three', summary: 'three' }, expected_revision: 99, provenance }))).toBe('revision_conflict');
      const events = store.listEvents({ initiative_id: initiative.uuid });
      const payloads = Object.fromEntries(events.map((event) => [event.event_type, Object.keys(event.payload).sort()]));
      expect(payloads.decision_recorded).toEqual(['human_key', 'initiative_id', 'status', 'uuid']);
      expect(payloads.decision_superseded).toEqual(['superseded_by', 'uuid']);
      expect(payloads.evidence_updated).toEqual(['initiative_id', 'locator', 'uuid']);
      expect(payloads.risk_status_changed).toEqual(['status', 'uuid']);
    } finally { store.close(); rmSync(dir, { recursive: true, force: true }); }
  });
});