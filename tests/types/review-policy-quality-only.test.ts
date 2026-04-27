import { describe, expect, it } from 'vitest';
import { inputSchema as delegateInputSchema } from '../../packages/core/src/tool-schemas/delegate.js';
import { inputSchema as executePlanInputSchema } from '../../packages/core/src/tool-schemas/execute-plan.js';
import type { TaskSpec } from '../../packages/core/src/types.js';
import type { DraftTask } from '../../packages/core/src/intake/types.js';

describe("reviewPolicy: 'quality_only'", () => {
  it('TaskSpec.reviewPolicy accepts quality_only at the type level', () => {
    const t: TaskSpec = { prompt: 'x', agentType: 'complex', reviewPolicy: 'quality_only' };
    expect(t.reviewPolicy).toBe('quality_only');
  });

  it('DraftTask.reviewPolicy accepts quality_only at the type level', () => {
    const d: DraftTask = { prompt: 'x', agentType: 'complex', reviewPolicy: 'quality_only' };
    expect(d.reviewPolicy).toBe('quality_only');
  });

  it('delegate Zod schema rejects quality_only at the HTTP boundary', () => {
    const result = delegateInputSchema.safeParse({
      tasks: [{ prompt: 'x', reviewPolicy: 'quality_only' }],
    });
    expect(result.success).toBe(false);
  });

  it('execute-plan Zod schema rejects quality_only at the HTTP boundary', () => {
    const result = executePlanInputSchema.safeParse({
      tasks: [{ task: 'x', reviewPolicy: 'quality_only' }],
    });
    expect(result.success).toBe(false);
  });
});
