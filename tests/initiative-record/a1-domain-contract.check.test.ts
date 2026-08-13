import { describe, expect, it } from 'vitest';
import {
  initiativeOperationRequestSchema,
  type AcceptanceCriterion,
  type Decision,
  type EvidenceLink,
  type Requirement,
  type Risk,
  type VerificationRun,
} from '../../packages/core/src/initiative-record/index.js';

const provenance = { actor_type: 'human', actor_id: 'u', interface: 'http', initiated_by: 'u', authorized_by: 'u', timestamp: '2026-08-13T00:00:00.000Z', source: 'check' };
const initiativeId = '00000000-0000-4000-8000-000000000001';
const requirementId = '00000000-0000-4000-8000-000000000002';

describe('Phase A1 domain contract', () => {
  it('accepts the frozen mutation and scoped-selector shapes', () => {
    expect(initiativeOperationRequestSchema.safeParse({ operation: 'requirement_add', input: { initiative_id: initiativeId, statement: 'S' }, expected_revision: 0, provenance }).success).toBe(true);
    expect(initiativeOperationRequestSchema.safeParse({ operation: 'acceptance_criterion_get', input: { requirement_id: requirementId, human_key: 'AC-1' } }).success).toBe(true);
    expect(initiativeOperationRequestSchema.safeParse({ operation: 'decision_record', input: { initiative_id: initiativeId, title: 'T', decision: 'D', rationale: 'R', alternatives: ['A'], status: 'superseded' }, expected_revision: 0, provenance }).success).toBe(false);
    expect(initiativeOperationRequestSchema.safeParse({ operation: 'risk_get', input: { human_key: 'RISK-1' } }).success).toBe(false);
    expect(initiativeOperationRequestSchema.safeParse({ operation: 'verification_update', input: {} }).success).toBe(false);
    expect(initiativeOperationRequestSchema.safeParse({ operation: 'risk_update', input: { uuid: initiativeId, severity: 'low' }, expected_revision: 1, provenance }).success).toBe(false);
    // Evidence.content_hash is nullable end to end: the frozen type is `string | null`.
    expect(initiativeOperationRequestSchema.safeParse({ operation: 'evidence_add', input: { initiative_id: initiativeId, kind: 'document', locator: 'doc://x', content_hash: null, summary: 'S' }, expected_revision: 0, provenance }).success).toBe(true);
  });

  it('keeps the frozen fields and enum literals type-visible', () => {
    const requirement: Pick<Requirement, 'human_key' | 'revision'> = { human_key: 'REQ-1', revision: 0 };
    const criterion: Pick<AcceptanceCriterion, 'check_reference'> = { check_reference: 'manual review' };
    const decision: Pick<Decision, 'status' | 'superseded_by'> = { status: 'decided', superseded_by: null };
    const link: EvidenceLink = { evidence_id: initiativeId, target_type: 'verification_run', target_id: requirementId, createdAt: '2026-08-13T00:00:00.000Z', revision: 0 };
    const risk: Pick<Risk, 'severity' | 'status'> = { severity: 'high', status: 'accepted' };
    const run: Pick<VerificationRun, 'method' | 'state'> = { method: 'agent-review', state: 'needs_human_review' };
    expect([requirement, criterion, decision, link, risk, run]).toHaveLength(6);
  });
});