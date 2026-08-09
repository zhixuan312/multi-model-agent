import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';

const flow = readFileSync('packages/server/src/skills/mma-flow/SKILL.md', 'utf8');

describe('deliverable lifecycle matrix', () => {
  it('contains approval-first, disposition-specific, and truthful terminal rules', () => {
    for (const state of ['awaiting-approval', 'awaiting-reapproval', 'awaiting-human-verification', 'stopped-unmet-requirements']) expect(flow).toContain(state);
    expect(flow).toContain('acceptanceClosed');
    expect(flow).toContain('declared order');
    expect(flow).toContain('commitBaseline');
    expect(flow).not.toContain('done-with-unmet-signal');
    expect(flow).not.toContain('post-delivery action');
  });
});