import { describe, expect, it } from 'vitest';
import { evaluateLifecycleGate } from '../../packages/core/src/initiative-record/lifecycle-gates.js';
import type { Event, LifecycleContract } from '../../packages/core/src/initiative-record/index.js';

const contract: LifecycleContract = {
  id: 'test@1',
  phases: {
    discover: { required: [{ key: 'manual_key', satisfier: 'manual' }] },
    refine: { required: [{ key: 'requirements_defined', satisfier: 'requirements_exist' }, { key: 'acceptance_criteria_defined', satisfier: 'acceptance_criteria_exist' }] },
    design: { required: [{ key: 'key_decisions_settled', satisfier: 'decisions_settled' }] },
    execute: { required: [] },
    verify: { required: [] },
    deliver: { required: [] },
  },
};
const event = (event_type: string, payload: Record<string, unknown>, sequence: number): Event => ({ event_sequence: sequence, entity_type: 'Initiative', entity_id: 'i', initiative_id: 'i', event_type, payload, actor_type: 'agent', actor_id: 'a', interface: 'test', initiated_by: 'a', authorized_by: 'a', timestamp: '2026-08-13T00:00:00.000Z', source: 'test' });

describe('Lifecycle gates', () => {
  it('evaluates all five satisfiers and keeps a null contract green', () => {
    expect(evaluateLifecycleGate({ contract: null, phase: 'discover', requirements: [], acceptanceCriteria: [], decisions: [], events: [], deliverableValidationStates: [] })).toEqual({ status: 'green', missing: [], note: 'No lifecycle contract is set.' });
    const refineRedResult = evaluateLifecycleGate({ contract, phase: 'refine', requirements: [], acceptanceCriteria: [], decisions: [], events: [], deliverableValidationStates: [] });
    expect(refineRedResult).toMatchObject({ status: 'red', missing: [{ establishment: { key: 'requirements_defined' } }, { establishment: { key: 'acceptance_criteria_defined' } }] });
    for (const missing of refineRedResult.missing) {
      expect(missing.satisfied).toBe(false);
      expect(missing.detail).toEqual(expect.any(String));
      expect(missing.detail.length).toBeGreaterThan(0);
    }
    expect(evaluateLifecycleGate({ contract, phase: 'refine', requirements: [{}], acceptanceCriteria: [{}], decisions: [], events: [], deliverableValidationStates: [] })).toMatchObject({ status: 'green', missing: [] });
    expect(evaluateLifecycleGate({ contract, phase: 'design', requirements: [], acceptanceCriteria: [], decisions: [{ status: 'open' }], events: [], deliverableValidationStates: [] })).toMatchObject({ status: 'red' });
    expect(evaluateLifecycleGate({ contract, phase: 'design', requirements: [], acceptanceCriteria: [], decisions: [{ status: 'decided' }], events: [], deliverableValidationStates: [] })).toMatchObject({ status: 'green' });
    expect(evaluateLifecycleGate({ contract, phase: 'design', requirements: [], acceptanceCriteria: [], decisions: [], events: [], deliverableValidationStates: [] })).toMatchObject({ status: 'green' });
  });

  it('scopes manual assertions and voids them after both supported exits from satisfied', () => {
    const satisfied = event('phase_satisfied', { phase: 'discover', previous_state: 'active', new_state: 'satisfied', asserted: ['manual_key'], gate_snapshot: { status: 'green', missing: [] } }, 1);
    expect(evaluateLifecycleGate({ contract, phase: 'discover', requirements: [], acceptanceCriteria: [], decisions: [], events: [satisfied], deliverableValidationStates: [] })).toMatchObject({ status: 'green' });
    const reopened = event('phase_reopened', { phase: 'discover', previous_state: 'satisfied', new_state: 'reopened', reason: 'finding' }, 2);
    expect(evaluateLifecycleGate({ contract, phase: 'discover', requirements: [], acceptanceCriteria: [], decisions: [], events: [satisfied, reopened], deliverableValidationStates: [] })).toMatchObject({ status: 'red' });
    const entered = event('phase_entered', { phase: 'discover', previous_state: 'satisfied', new_state: 'active' }, 2);
    expect(evaluateLifecycleGate({ contract, phase: 'discover', requirements: [], acceptanceCriteria: [], decisions: [], events: [satisfied, entered], deliverableValidationStates: [] })).toMatchObject({ status: 'red' });
    const otherContract = event('phase_satisfied', { phase: 'discover', previous_state: 'active', new_state: 'satisfied', asserted: ['manual_key'], gate_snapshot: { status: 'green', missing: [] } }, 1);
    const contractChange = event('lifecycle_contract_set', { previous_lifecycle_contract: 'other@1', new_lifecycle_contract: 'test@1' }, 2);
    expect(evaluateLifecycleGate({ contract, phase: 'discover', requirements: [], acceptanceCriteria: [], decisions: [], events: [otherContract, contractChange], deliverableValidationStates: [] })).toMatchObject({ status: 'red' });
  });
});