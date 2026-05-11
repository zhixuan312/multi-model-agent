import { describe, it, expect } from 'vitest';
import type { TaskSpec } from '../../packages/core/src/types/task-spec.js';

describe('TaskSpec.completionThreshold', () => {
  it('accepts the optional completionThreshold field', () => {
    const spec: TaskSpec = {
      prompt: 'do work',
      cwd: '/tmp',
      agentType: 'standard',
      completionThreshold: 80,
    } as TaskSpec;
    expect(spec.completionThreshold).toBe(80);
  });

  it('treats completionThreshold as optional', () => {
    const spec: TaskSpec = {
      prompt: 'do work',
      cwd: '/tmp',
      agentType: 'standard',
    } as TaskSpec;
    expect(spec.completionThreshold).toBeUndefined();
  });
});
