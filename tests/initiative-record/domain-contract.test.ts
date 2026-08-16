import { describe, expect, it } from 'vitest';
import {
  initiativeOperationRequestSchema,
  initiativeResumeRequestSchema,
  provenanceSchema,
  type InitiativeResumeResponse,
} from '../../packages/core/src/initiative-record/index.js';

const provenance = {
  actor_type: 'human', actor_id: 'u1', interface: 'http',
  initiated_by: 'u1', authorized_by: 'u1', timestamp: '2026-08-12T00:00:00.000Z', source: 'manual',
};

describe('Initiative Record public contract', () => {
  it('accepts the frozen create contract and rejects malformed write boundaries', () => {
    expect(initiativeOperationRequestSchema.safeParse({
      operation: 'initiative_create',
      input: { product_id: '00000000-0000-4000-8000-000000000001', title: 'T', goal: 'G', status: 'open', outcome: null },
      expected_revision: 0, provenance,
    }).success).toBe(true);
    expect(initiativeOperationRequestSchema.safeParse({
      operation: 'initiative_create', input: { title: 'T', goal: 'G', status: 'open', outcome: 'delivered' },
      expected_revision: 0, provenance: { ...provenance, actor_type: 'robot' },
    }).success).toBe(false);
  });

  it('requires exactly one resume lookup and bounds event_limit', () => {
    expect(initiativeResumeRequestSchema.safeParse({ initiative: { human_key: 'MMA-INIT-1' }, event_limit: 100 }).success).toBe(true);
    expect(initiativeResumeRequestSchema.safeParse({ initiative: { uuid: '00000000-0000-4000-8000-000000000001', human_key: 'MMA-INIT-1' } }).success).toBe(false);
    expect(initiativeResumeRequestSchema.safeParse({ initiative: { human_key: 'MMA-INIT-1' }, event_limit: 101 }).success).toBe(false);
  });

  it('keeps exactly the pinned resume sections and provenance fields type-visible', () => {
    type Equal<A, B> = (<T>() => T extends A ? 1 : 2) extends (<T>() => T extends B ? 1 : 2) ? true : false;
    type Assert<T extends true> = T;
    type ResponseKeys = 'initiative' | 'product' | 'workspaces' | 'related_initiatives' | 'tasks' | 'artifacts' | 'events' | 'requirements' | 'decisions' | 'risks' | 'evidence' | 'verification' | 'lifecycle' | 'deliverables' | 'counts';
    const exactKeys: Assert<Equal<keyof InitiativeResumeResponse, ResponseKeys>> = true;
    expect(exactKeys).toBe(true);
    expect(provenanceSchema.safeParse(provenance).success).toBe(true);
  });
});