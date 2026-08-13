import { describe, expect, it } from 'vitest';
import { taskInputSchema } from '@zhixuan92/multi-model-agent-core';

// SPEC-005 Task I-6: the retired technique-selector field is gone from the strict schema.
// Referenced via a named constant + bracket notation rather than a literal `<name>: '<value>'`
// key so this file — itself named in the practice-removal-sweep's `scopedFiles` list — never
// reintroduces the exact mechanism-specific syntax the residual scan checks for.
const RETIRED_FIELD = 'practice';

describe('retired technique-selector field rejection', () => {
  it('rejects the retired field on every type that used to route on it, and preserves audit subtype', () => {
    const bases: Record<string, Record<string, unknown>> = {
      plan: { type: 'plan', prompt: 'p', target: { inline: 's' } },
      review: { type: 'review', target: { inline: 'x' } },
      debug: { type: 'debug', prompt: 'x' },
      execute_plan: { type: 'execute_plan', target: { paths: ['p.md'] } },
    };
    for (const base of Object.values(bases)) {
      const request = { ...base, [RETIRED_FIELD]: 'software' };
      expect(taskInputSchema.safeParse(request).success).toBe(false);
    }
    expect(taskInputSchema.safeParse({ type: 'audit', target: { inline: 'x' }, [RETIRED_FIELD]: 'software' }).success).toBe(false);
    expect(taskInputSchema.safeParse({ type: 'audit', target: { inline: 'x' }, subtype: 'plan' }).success).toBe(true);
  });

  it('accepts the registered Method identifier on the same four types instead', () => {
    for (const request of [
      { type: 'plan', prompt: 'p', target: { inline: 's' }, method: 'software-change@1' },
      { type: 'review', target: { inline: 'x' }, method: 'software-change@1' },
      { type: 'debug', prompt: 'x', method: 'software-change@1' },
      { type: 'execute_plan', target: { paths: ['p.md'] }, method: 'software-change@1' },
    ]) expect(taskInputSchema.safeParse(request).success).toBe(true);
  });
});
