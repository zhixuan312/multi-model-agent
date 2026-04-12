import { describe, it, expect } from 'vitest';
import { evaluateReadiness } from '@zhixuan92/multi-model-agent-core/readiness/readiness';
import type { TaskSpec } from '@zhixuan92/multi-model-agent-core';

describe('real-plan regressions', () => {
  it('"follow the same pattern as X" triggers outsourced-discovery', () => {
    const task: TaskSpec = {
      prompt: 'Update auth middleware at src/auth/middleware.ts. Follow the same pattern as users.ts. Done when tsc passes.',
      agentType: 'standard',
    };
    const r = evaluateReadiness(task, 'normalize');
    expect(r.action).toBe('normalize');
    expect(r.layer2Warnings).toContain('outsourced_discovery');
  });

  it('bare line-range anchor triggers brittle-line-anchors', () => {
    const task: TaskSpec = {
      prompt: 'Extract logic in src/stats.ts lines 98-386 into a helper. Done when tsc passes.',
      agentType: 'standard',
    };
    expect(evaluateReadiness(task, 'normalize').layer2Warnings).toContain('brittle_line_anchors');
  });

  it('mixed environment actions triggers mixed_environment_actions', () => {
    const task: TaskSpec = {
      prompt: 'Update src/version.ts to 1.0.0. Then commit and push. Done when tsc passes.',
      agentType: 'standard',
    };
    expect(evaluateReadiness(task, 'normalize').layer2Warnings).toContain('mixed_environment_actions');
  });

  it('ideal fully-closed brief has zero Layer 2 warnings', () => {
    const task: TaskSpec = {
      prompt: 'Update `src/auth/middleware.ts` to use `jsonwebtoken`. Import `verifyToken` from `src/auth/jwt-utils.ts`. Do not modify `src/auth/jwt-utils.ts`. Done when tsc passes.',
      agentType: 'complex',
    };
    const r = evaluateReadiness(task, 'normalize');
    expect(r.layer2Warnings).toEqual([]);
    expect(r.action).toBe('warn');
  });
});
