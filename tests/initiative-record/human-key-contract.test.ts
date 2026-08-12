import { describe, expect, it } from 'vitest';
import { initiativeResumeRequestSchema } from '../../packages/core/src/initiative-record/index.js';

describe('Initiative human-key contract', () => {
  it('accepts the pinned bootstrap human key', () => {
    expect(
      initiativeResumeRequestSchema.safeParse({ initiative: { human_key: 'MMA-INIT-001' } }).success,
    ).toBe(true);
  });
});
