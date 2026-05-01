import { describe, it, expect } from 'vitest';
import { buildTaskCompletedEvent } from '../../packages/core/src/telemetry/event-builder.js';
import type { RunResult } from '../../packages/core/src/types.js';
import { HAPPY } from './fixtures/runresult.js';

function makeFixtureRunResult(overrides: Partial<RunResult>): RunResult {
  return { ...structuredClone(HAPPY), ...overrides } as RunResult;
}

describe('event-builder tier vocabulary', () => {
  it('emits agentTier as canonical "complex" (not "reasoning")', () => {
    const rr = makeFixtureRunResult({
      stageStats: {
        ...HAPPY.stageStats,
        implementing: {
          ...HAPPY.stageStats!.implementing,
          agentTier: 'complex',
        },
      },
    } as RunResult);
    const event = buildTaskCompletedEvent({
      route: 'delegate',
      taskSpec: { filePaths: [] },
      runResult: rr,
      client: 'test',
      parentModel: null,
    });
    const stage = event.stages.find(s => s.name === 'implementing')!;
    expect(stage.agentTier).toBe('complex');
  });

  it('emits agentTier as canonical "standard" unchanged', () => {
    const rr = makeFixtureRunResult({});
    const event = buildTaskCompletedEvent({
      route: 'delegate',
      taskSpec: { filePaths: [] },
      runResult: rr,
      client: 'test',
      parentModel: null,
    });
    const stage = event.stages.find(s => s.name === 'implementing')!;
    expect(stage.agentTier).toBe('standard');
  });
});
