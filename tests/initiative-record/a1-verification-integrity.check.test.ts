import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { InitiativeRecordStore } from '../../packages/core/src/initiative-record/index.js';

const provenance = { actor_type: 'agent', actor_id: 'a', interface: 'mcp', initiated_by: 'a', authorized_by: 'h', timestamp: '2026-08-13T00:00:00.000Z', source: 'check' };
function errorCode(fn: () => unknown): string | undefined { try { fn(); } catch (error) { return (error as { code?: string }).code; } return undefined; }

describe('Phase A1 verification integrity', () => {
  it('rejects cross-initiative writes, supersedes only pinned states, and stales only linked completed runs', () => {
    const dir = mkdtempSync(join(tmpdir(), 'mma-a1-verification-'));
    const store = InitiativeRecordStore.open({ dbPath: join(dir, 'initiatives.db') });
    try {
      const product = store.execute({ operation: 'product_create', input: { name: 'P', slug: 'p' }, expected_revision: 0, provenance }) as { uuid: string };
      const makeInitiative = (title: string) => store.execute({ operation: 'initiative_create', input: { product_id: product.uuid, title, goal: 'G', status: 'open', outcome: null }, expected_revision: 0, provenance }) as { uuid: string };
      const first = makeInitiative('A'); const second = makeInitiative('B');
      const foreignTask = store.execute({ operation: 'initiative_task_create', input: { initiative_id: second.uuid, title: 'foreign', goal: 'g', status: 'open', outcome: null, workspace_ids: [], resource_ids: [] }, expected_revision: 0, provenance }) as { uuid: string };
      const requirement = store.execute({ operation: 'requirement_add', input: { initiative_id: first.uuid, statement: 'S' }, expected_revision: 0, provenance }) as { uuid: string };
      const criterion = store.execute({ operation: 'acceptance_criterion_add', input: { requirement_id: requirement.uuid, statement: 'C', check_reference: 'c' }, expected_revision: 0, provenance }) as { uuid: string };
      const evidence = store.execute({ operation: 'evidence_add', input: { initiative_id: first.uuid, kind: 'file', locator: 'a', content_hash: 'one', summary: 's' }, expected_revision: 0, provenance }) as { uuid: string; revision: number };
      const eventsBefore = store.listEvents({}).length;
      expect(errorCode(() => store.execute({ operation: 'evidence_link', input: { evidence_id: evidence.uuid, target_type: 'task', target_id: foreignTask.uuid }, expected_revision: 0, provenance }))).toBe('cross_initiative_evidence_link');
      expect(store.listEvents({})).toHaveLength(eventsBefore);
      expect(errorCode(() => store.execute({ operation: 'verification_record', input: { initiative_id: second.uuid, acceptance_criterion_id: criterion.uuid, method: 'command', state: 'pass', detail: 'x' }, expected_revision: 0, provenance }))).toBe('cross_initiative_verification');
      const run = store.execute({ operation: 'verification_record', input: { initiative_id: first.uuid, acceptance_criterion_id: criterion.uuid, method: 'command', state: 'pass', detail: 'x' }, expected_revision: 0, provenance }) as { uuid: string };
      const pending = store.execute({ operation: 'verification_record', input: { initiative_id: first.uuid, acceptance_criterion_id: criterion.uuid, method: 'human', state: 'pending', detail: 'pending' }, expected_revision: 0, provenance }) as { uuid: string };
      expect(store.getVerificationRun({ uuid: run.uuid })).toMatchObject({ state: 'superseded' });
      const staleCandidate = store.execute({ operation: 'verification_record', input: { initiative_id: first.uuid, acceptance_criterion_id: criterion.uuid, method: 'command', state: 'pass', detail: 'stale me' }, expected_revision: 0, provenance }) as { uuid: string };
      expect(store.getVerificationRun({ uuid: pending.uuid })).toMatchObject({ state: 'superseded' });
      const link = store.execute({ operation: 'evidence_link', input: { evidence_id: evidence.uuid, target_type: 'verification_run', target_id: staleCandidate.uuid }, expected_revision: 0, provenance });
      const eventsBeforeDuplicate = store.listEvents({}).length;
      const duplicate = store.execute({ operation: 'evidence_link', input: { evidence_id: evidence.uuid, target_type: 'verification_run', target_id: staleCandidate.uuid }, expected_revision: 0, provenance });
      expect(duplicate).toEqual(link);
      expect(store.listEvents({})).toHaveLength(eventsBeforeDuplicate);
      const updatedEvidence = store.execute({ operation: 'evidence_add', input: { initiative_id: first.uuid, kind: 'file', locator: 'a', content_hash: 'two', summary: 's' }, expected_revision: evidence.revision, provenance }) as { revision: number };
      expect(store.getVerificationRun({ uuid: staleCandidate.uuid })).toMatchObject({ state: 'stale' });
      const latest = store.execute({ operation: 'verification_record', input: { initiative_id: first.uuid, acceptance_criterion_id: criterion.uuid, method: 'human', state: 'pass', detail: 'y' }, expected_revision: 0, provenance }) as { uuid: string };
      expect(store.getVerificationRun({ uuid: latest.uuid })).toMatchObject({ state: 'pass' });
      store.execute({ operation: 'evidence_link', input: { evidence_id: evidence.uuid, target_type: 'verification_run', target_id: latest.uuid }, expected_revision: 0, provenance });
      const staleEventsBeforeUnchangedHash = store.listEvents({}).filter((event) => event.event_type === 'verification_stale').length;
      store.execute({ operation: 'evidence_add', input: { initiative_id: first.uuid, kind: 'file', locator: 'a', content_hash: 'two', summary: 'unchanged hash' }, expected_revision: updatedEvidence.revision, provenance });
      expect(store.getVerificationRun({ uuid: latest.uuid })).toMatchObject({ state: 'pass' });
      expect(store.listEvents({}).filter((event) => event.event_type === 'verification_stale')).toHaveLength(staleEventsBeforeUnchangedHash);
      expect(store.listEvents({}).length).toBeGreaterThan(eventsBefore);
      expect(store.listEvents({}).filter((event) => event.event_type === 'verification_superseded')).toHaveLength(2);
      expect(store.listEvents({}).filter((event) => event.event_type === 'verification_stale')).toHaveLength(1);
    } finally { store.close(); rmSync(dir, { recursive: true, force: true }); }
  });
});