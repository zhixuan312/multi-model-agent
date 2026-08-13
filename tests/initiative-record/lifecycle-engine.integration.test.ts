import { describe, expect, it } from 'vitest';
import { boot } from '../contract/fixtures/harness.js';
import { mockProvider } from '../contract/fixtures/mock-providers.js';

const headers = (token: string) => ({ 'Content-Type': 'application/json', 'X-MMA-Client': 'claude-code', Authorization: `Bearer ${token}` });
const provenance = { actor_type: 'agent', actor_id: 'host-a', interface: 'ignored', initiated_by: 'host-a', authorized_by: 'host-a', timestamp: 'ignored', source: 'test' };
async function request(h: { baseUrl: string; token: string }, body: Record<string, unknown>) {
  const response = await fetch(`${h.baseUrl}/initiatives`, { method: 'POST', headers: headers(h.token), body: JSON.stringify(body) });
  expect(response.status).toBe(200);
  return await response.json() as Record<string, any>;
}
async function revision(h: { baseUrl: string; token: string }, uuid: string) {
  const initiative = await request(h, { operation: 'initiative_get', input: { uuid } });
  return initiative.revision as number;
}
async function mutate(h: { baseUrl: string; token: string }, operation: string, input: Record<string, unknown>, initiativeId: string) {
  return request(h, { operation, input, expected_revision: await revision(h, initiativeId), provenance });
}
// `requirement_add`/`acceptance_criterion_add` create their OWN new entity, whose own
// revision starts at 0 (`requireCreateRevision`) — independent of the Initiative's own
// revision counter that `mutate()` looks up. Passing the Initiative's (by-then nonzero)
// revision here would throw `revision_conflict`.
async function create(h: { baseUrl: string; token: string }, operation: string, input: Record<string, unknown>) {
  return request(h, { operation, input, expected_revision: 0, provenance });
}

describe('Lifecycle Engine integration', () => {
  it('walks a real HTTP store through advisory lifecycle state and resumes the full position', async () => {
    const h = await boot({ provider: mockProvider({ stage: 'ok' }), cwd: process.cwd() });
    try {
      const product = await request(h, { operation: 'product_create', input: { name: 'MMA', slug: 'mma-lifecycle-integration' }, expected_revision: 0, provenance });
      const initiative = await request(h, { operation: 'initiative_create', input: { product_id: product.uuid, title: 'Lifecycle', goal: 'Record phases', status: 'open', outcome: null }, expected_revision: 0, provenance });
      await mutate(h, 'initiative_phase_enter', { initiative: { uuid: initiative.uuid }, phase: 'discover' }, initiative.uuid);
      await mutate(h, 'initiative_phase_satisfy', { initiative: { uuid: initiative.uuid }, phase: 'discover', asserted: ['problem_framed'] }, initiative.uuid);
      await mutate(h, 'initiative_phase_enter', { initiative: { uuid: initiative.uuid }, phase: 'refine' }, initiative.uuid);
      await mutate(h, 'initiative_phase_satisfy', { initiative: { uuid: initiative.uuid }, phase: 'refine' }, initiative.uuid);
      const redRefine = await request(h, { operation: 'initiative_gate_status', input: { initiative: { uuid: initiative.uuid } } });
      expect(redRefine.phases.find((entry: { phase: string }) => entry.phase === 'refine')).toMatchObject({ gate: { status: 'red' } });
      await mutate(h, 'initiative_phase_reopen', { initiative: { uuid: initiative.uuid }, phase: 'refine', reason: 'requirements arrived' }, initiative.uuid);
      const requirement = await create(h, 'requirement_add', { initiative_id: initiative.uuid, statement: 'The engine stores lifecycle facts.' });
      await create(h, 'acceptance_criterion_add', { requirement_id: requirement.uuid, statement: 'A read returns lifecycle.', check_reference: 'lifecycle-engine.integration.test.ts' });
      // `refine` also requires the manual `scoped_goal` establishment (default-sdl@1); asserting
      // it here — alongside the now-present Requirement and AcceptanceCriterion — is what makes
      // the final green-gate assertion below true.
      await mutate(h, 'initiative_phase_satisfy', { initiative: { uuid: initiative.uuid }, phase: 'refine', asserted: ['scoped_goal'] }, initiative.uuid);
      await mutate(h, 'initiative_phase_enter', { initiative: { uuid: initiative.uuid }, phase: 'design' }, initiative.uuid);
      await mutate(h, 'initiative_phase_satisfy', { initiative: { uuid: initiative.uuid }, phase: 'design', asserted: ['design_artifact'] }, initiative.uuid);
      await mutate(h, 'initiative_phase_reopen', { initiative: { uuid: initiative.uuid }, phase: 'design', reason: 'verification finding' }, initiative.uuid);
      await mutate(h, 'initiative_focus_set', { initiative: { uuid: initiative.uuid }, phase: 'design' }, initiative.uuid);
      const resumed = await request(h, { operation: 'initiative_resume', initiative: { uuid: initiative.uuid } });
      expect(resumed.lifecycle).toMatchObject({ focus_phase: 'design', contract: 'default-sdl@1' });
      expect(resumed.lifecycle.phases.map((entry: { phase: string }) => entry.phase)).toEqual(['discover', 'refine', 'design', 'execute', 'verify', 'deliver']);
      expect(resumed.lifecycle.phases.find((entry: { phase: string }) => entry.phase === 'discover')).toMatchObject({ state: 'satisfied', gate: { status: 'green' } });
      expect(resumed.lifecycle.phases.find((entry: { phase: string }) => entry.phase === 'refine')).toMatchObject({ state: 'satisfied', gate: { status: 'green' } });
      expect(resumed.lifecycle.phases.find((entry: { phase: string }) => entry.phase === 'design')).toMatchObject({ state: 'reopened' });
      expect(resumed.lifecycle.recent_lifecycle_events).toEqual(expect.arrayContaining([expect.objectContaining({ event_type: 'phase_reopened', payload: expect.objectContaining({ phase: 'design', reason: 'verification finding' }) }), expect.objectContaining({ event_type: 'phase_satisfied', payload: expect.objectContaining({ phase: 'refine', gate_snapshot: expect.any(Object) }) })]));
    } finally { await h.close(); }
  });
});