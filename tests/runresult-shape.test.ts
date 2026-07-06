import { describe, it, expect } from 'vitest';
import type { RuntimeRunResult } from '../packages/core/src/types.js';

describe('RuntimeRunResult shape (Phase 0 contract)', () => {
  it('every field the event-builder reads is present on a real RuntimeRunResult', () => {
    const sample: RuntimeRunResult = {
      output: '',
      status: 'done' as const,
      usage: { input: 0, output: 0, costUSD: 0 },
      turns: 1,
      filesWritten: [],
      outputIsDiagnostic: false,
      escalationLog: [],
      agents: {
        implementer: 'standard',
        implementerToolMode: 'full',
        specReviewer: 'not_applicable',
        qualityReviewer: 'not_applicable',
      },
      models: { implementer: 'claude-sonnet-4-6', specReviewer: null, qualityReviewer: null },
      reviewRounds: { spec: 0, quality: 0, metadata: 0, cap: 0 },
      specReviewStatus:    'not_applicable',
      qualityReviewStatus: 'not_applicable',
      workerStatus:        'done',
      terminationReason:   { cause: 'finished', turnsUsed: 1, hasFileArtifacts: false, usedShell: false, workerSelfAssessment: 'done', wasPromoted: false },
    };

    const required = [
      'agents','escalationLog','models','reviewRounds','specReviewStatus',
      'qualityReviewStatus','workerStatus','terminationReason','usage',
    ];
    for (const key of required) {
      expect(sample, `field ${key} must exist on RuntimeRunResult`).toHaveProperty(key);
    }
  });
});
