import { describe, expect, it } from 'vitest';
import { executePlanInputSchema } from '../../packages/core/src/tools/execute-plan/tool-config.js';
import type { TaskSpec } from '../../packages/core/src/types.js';

describe("reviewPolicy: 'quality_only'", () => {
  it('TaskSpec.reviewPolicy accepts quality_only at the type level', () => {
    const t: TaskSpec = { prompt: 'x', agentType: 'complex', reviewPolicy: 'quality_only' };
    expect(t.reviewPolicy).toBe('quality_only');
  });

  it('execute-plan Zod schema accepts quality_only (perTaskReviewPolicy)', () => {
    const result = executePlanInputSchema.safeParse({
      filePaths: ['plan.md'],
      taskDescriptors: ['x'],
      perTaskReviewPolicy: { '0': 'quality_only' },
    });
    expect(result.success).toBe(true);
  });
});
