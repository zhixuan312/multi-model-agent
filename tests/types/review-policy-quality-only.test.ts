import { describe, expect, it } from 'vitest';
import { inputSchema as delegateInputSchema } from '../../packages/core/src/tools/delegate/schema.js';
import { inputSchema as executePlanInputSchema } from '../../packages/core/src/tools/execute-plan/schema.js';
import type { TaskSpec } from '../../packages/core/src/types.js';

describe("reviewPolicy: 'quality_only'", () => {
  it('TaskSpec.reviewPolicy accepts quality_only at the type level', () => {
    const t: TaskSpec = { prompt: 'x', agentType: 'complex', reviewPolicy: 'quality_only' };
    expect(t.reviewPolicy).toBe('quality_only');
  });

  it('delegate Zod schema accepts quality_only', () => {
    const result = delegateInputSchema.safeParse({
      tasks: [{ prompt: 'x', reviewPolicy: 'quality_only' }],
    });
    expect(result.success).toBe(true);
  });

  it('execute-plan Zod schema accepts quality_only', () => {
    const result = executePlanInputSchema.safeParse({
      tasks: [{ task: 'x', reviewPolicy: 'quality_only' }],
    });
    expect(result.success).toBe(true);
  });
});
