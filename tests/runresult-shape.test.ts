import { describe, it, expect } from 'vitest';
import type { RuntimeRunResult } from '../packages/core/src/types.js';

describe('RuntimeRunResult shape (Phase 0 contract)', () => {
  it('every field the event-builder reads is present on a real RuntimeRunResult', () => {
    const sample: RuntimeRunResult = {
      output: '',
      status: 'done' as const,
      usage: { inputTokens: 0, outputTokens: 0, cachedReadTokens: 0, cachedNonReadTokens: 0 },
      actualCostUSD: 0,
      turns: 1,
      filesWritten: [],
      escalationLog: [],
      agents: {
        implementer: 'standard',
        implementerToolMode: 'full',
      },
      models: { implementer: 'claude-sonnet-4-6', reviewer: undefined },
      workerStatus:        'done',
      terminationReason:   { cause: 'finished', turnsUsed: 1, hasFileArtifacts: false, usedShell: false, workerSelfAssessment: 'done', wasPromoted: false },
    };

    const required = [
      'agents','escalationLog','models',
      'workerStatus','terminationReason','usage',
    ];
    for (const key of required) {
      expect(sample, `field ${key} must exist on RuntimeRunResult`).toHaveProperty(key);
    }
  });
});
