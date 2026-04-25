import { describe, it, expect } from 'vitest';
import {
  emptyStats,
  endBaseStage,
  endVerifyStage,
  endReviewStage,
} from '../../packages/core/src/run-tasks/reviewed-lifecycle.js';
import type { StageStatsMap } from '../../packages/core/src/types.js';

describe('emptyStats', () => {
  it('returns a StageStatsMap with all stages having entered=false', () => {
    const stats = emptyStats();
    const stages = Object.values(stats);
    expect(stages).toHaveLength(8);
    for (const s of stages) {
      expect(s.entered).toBe(false);
      expect(s.durationMs).toBeNull();
      expect(s.costUSD).toBeNull();
    }
  });

  it('returns stage entries with correct discriminated stage field', () => {
    const stats = emptyStats();
    expect(stats.implementing.stage).toBe('implementing');
    expect(stats.verifying.stage).toBe('verifying');
    expect(stats.spec_review.stage).toBe('spec_review');
    expect(stats.spec_rework.stage).toBe('spec_rework');
    expect(stats.quality_review.stage).toBe('quality_review');
    expect(stats.quality_rework.stage).toBe('quality_rework');
    expect(stats.diff_review.stage).toBe('diff_review');
    expect(stats.committing.stage).toBe('committing');
  });
});

describe('endBaseStage', () => {
  const agent = { tier: 'standard' as const, family: 'claude', model: 'claude-sonnet-4-6' };

  it('records implementing stage with entered=true and computed duration/cost', () => {
    const stats = emptyStats();
    const t0 = Date.now() - 5000;
    const c0 = 0.01;
    endBaseStage(stats, 'implementing', t0, c0, agent, 0.05);
    expect(stats.implementing.entered).toBe(true);
    expect(stats.implementing.durationMs).toBeGreaterThanOrEqual(5000);
    expect(stats.implementing.costUSD).toBeCloseTo(0.04);
    expect(stats.implementing.agentTier).toBe('standard');
    expect(stats.implementing.modelFamily).toBe('claude');
    expect(stats.implementing.model).toBe('claude-sonnet-4-6');
  });

  it('records committing stage correctly', () => {
    const stats = emptyStats();
    const t0 = Date.now() - 1000;
    endBaseStage(stats, 'committing', t0, 0, agent, 0);
    expect(stats.committing.entered).toBe(true);
    expect(stats.committing.durationMs).toBeGreaterThanOrEqual(1000);
  });

  it('handles null costs', () => {
    const stats = emptyStats();
    endBaseStage(stats, 'implementing', Date.now() - 1000, null as any, agent, null);
    expect(stats.implementing.entered).toBe(true);
    expect(stats.implementing.costUSD).toBeNull();
  });
});

describe('endVerifyStage', () => {
  const agent = { tier: 'complex' as const, family: 'gpt', model: 'gpt-5.5' };

  it('records passed verification', () => {
    const stats = emptyStats();
    const t0 = Date.now() - 3000;
    endVerifyStage(stats, t0, 0.02, agent, 0.08, 'passed', null);
    expect(stats.verifying.entered).toBe(true);
    expect(stats.verifying.outcome).toBe('passed');
    expect(stats.verifying.skipReason).toBeNull();
    expect(stats.verifying.durationMs).toBeGreaterThanOrEqual(3000);
    expect(stats.verifying.costUSD).toBeCloseTo(0.06);
    expect(stats.verifying.agentTier).toBe('complex');
    expect(stats.verifying.modelFamily).toBe('gpt');
    expect(stats.verifying.model).toBe('gpt-5.5');
  });

  it('records skipped verification with skipReason', () => {
    const stats = emptyStats();
    endVerifyStage(stats, Date.now(), 0, agent, 0, 'skipped', 'no_command');
    expect(stats.verifying.entered).toBe(true);
    expect(stats.verifying.outcome).toBe('skipped');
    expect(stats.verifying.skipReason).toBe('no_command');
  });

  it('records failed verification', () => {
    const stats = emptyStats();
    endVerifyStage(stats, Date.now(), 0, agent, 0, 'failed', null);
    expect(stats.verifying.outcome).toBe('failed');
  });

  it('records not_applicable verification', () => {
    const stats = emptyStats();
    endVerifyStage(stats, Date.now(), 0, agent, 0, 'not_applicable', null);
    expect(stats.verifying.outcome).toBe('not_applicable');
  });
});

describe('endReviewStage', () => {
  const agent = { tier: 'standard' as const, family: 'claude', model: 'claude-sonnet-4-6' };

  it('records approved spec_review with roundsUsed', () => {
    const stats = emptyStats();
    const t0 = Date.now() - 10000;
    endReviewStage(stats, 'spec_review', t0, 0.05, agent, 0.10, 'approved', 0);
    expect(stats.spec_review.entered).toBe(true);
    expect(stats.spec_review.verdict).toBe('approved');
    expect(stats.spec_review.roundsUsed).toBe(0);
    expect(stats.spec_review.durationMs).toBeGreaterThanOrEqual(10000);
  });

  it('records changes_required quality_review', () => {
    const stats = emptyStats();
    endReviewStage(stats, 'quality_review', Date.now(), 0, agent, 0.05, 'changes_required', 2);
    expect(stats.quality_review.entered).toBe(true);
    expect(stats.quality_review.verdict).toBe('changes_required');
    expect(stats.quality_review.roundsUsed).toBe(2);
  });

  it('records diff_review with skipped verdict', () => {
    const stats = emptyStats();
    endReviewStage(stats, 'diff_review', Date.now(), 0, agent, 0, 'skipped', 0);
    expect(stats.diff_review.entered).toBe(true);
    expect(stats.diff_review.verdict).toBe('skipped');
  });

  it('records error verdict for diff_review', () => {
    const stats = emptyStats();
    endReviewStage(stats, 'diff_review', Date.now(), 0, agent, 0, 'error', 0);
    expect(stats.diff_review.verdict).toBe('error');
  });
});

describe('StageStatsMap type safety', () => {
  it('stage entries remain non-null after end* calls', () => {
    const stats = emptyStats();
    const agent = { tier: 'standard' as const, family: 'test', model: 'test-model' };

    // Before: everything is null
    expect(stats.implementing.entered).toBe(false);
    expect(stats.verifying.entered).toBe(false);

    // After: populated
    endBaseStage(stats, 'implementing', Date.now() - 100, 0, agent, 0.01);
    expect(stats.implementing.entered).toBe(true);
    expect(stats.implementing.durationMs).not.toBeNull();

    endVerifyStage(stats, Date.now() - 100, 0, agent, 0.01, 'passed', null);
    expect(stats.verifying.entered).toBe(true);
    expect(stats.verifying.outcome).toBe('passed');
  });
});
