import { describe, it, expect, expectTypeOf } from 'vitest';
import type { RunResult, RawStageStats } from '../packages/core/src/types.js';

describe('RunResult shape (Phase 0 contract)', () => {
  it('exposes stageStats keyed by every stage name the telemetry schema reads', () => {
    type StageName =
      | 'implementing' | 'verifying' | 'spec_review' | 'spec_rework'
      | 'quality_review' | 'quality_rework' | 'diff_review' | 'committing';
    expectTypeOf<keyof NonNullable<RunResult['stageStats']>>().toEqualTypeOf<StageName>();
  });

  it('RawStageStats carries raw cost / duration / agent / model fields', () => {
    expectTypeOf<RawStageStats>().toMatchTypeOf<{
      entered:     boolean;
      durationMs:  number | null;
      costUSD:     number | null;
      agentTier:   'standard' | 'complex' | null;
      modelFamily: string | null;
      model:       string | null;
    }>();
  });

  it('every field the event-builder reads is present on a real RunResult', () => {
    const sample: RunResult = {
      output: '',
      status: 'done' as const,
      usage: { input: 0, output: 0, costUSD: 0 },
      turns: 1,
      filesRead: [],
      filesWritten: [],
      toolCalls: [],
      outputIsDiagnostic: false,
      escalationLog: [],
      agents: {
        implementer: 'standard',
        implementerToolMode: 'full',
        implementerCapabilities: [],
        specReviewer: 'not_applicable',
        qualityReviewer: 'not_applicable',
      },
      models: { implementer: 'claude-sonnet-4-6', specReviewer: null, qualityReviewer: null },
      reviewRounds: { spec: 0, quality: 0, metadata: 0, cap: 0 },
      specReviewStatus:    'not_applicable',
      qualityReviewStatus: 'not_applicable',
      workerStatus:        'done',
      terminationReason:   { cause: 'finished', turnsUsed: 1, hasFileArtifacts: false, usedShell: false, workerSelfAssessment: 'done', wasPromoted: false },
      concerns:            [],
      stageStats:          undefined,
    };

    const required = [
      'agents','escalationLog','models','reviewRounds','specReviewStatus',
      'qualityReviewStatus','workerStatus','terminationReason','toolCalls',
      'usage','concerns','stageStats',
    ];
    for (const key of required) {
      expect(sample, `field ${key} must exist on RunResult`).toHaveProperty(key);
    }
  });
});
