import { describe, expect, it } from 'vitest';
import { taskInputSchema } from '@zhixuan92/multi-model-agent-core';

describe('practice routing contract', () => {
  it('allows software only on the four routed types and preserves audit subtype', () => {
    for (const request of [
      { type: 'plan', prompt: 'p', target: { inline: 's' }, practice: 'software' },
      { type: 'review', target: { inline: 'x' }, practice: 'software' },
      { type: 'debug', prompt: 'x', practice: 'software' },
      { type: 'execute_plan', target: { paths: ['p.md'] }, practice: 'software' },
    ]) expect(taskInputSchema.safeParse(request).success).toBe(true);
    expect(taskInputSchema.safeParse({ type: 'audit', target: { inline: 'x' }, practice: 'software' }).success).toBe(false);
    expect(taskInputSchema.safeParse({ type: 'audit', target: { inline: 'x' }, subtype: 'plan' }).success).toBe(true);
  });
});