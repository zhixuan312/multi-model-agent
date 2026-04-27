import { describe, it, expect } from 'vitest';
import {
  emptyStats,
  endBaseStage,
  endVerifyStage,
  endReviewStage,
  executeReviewedLifecycle,
} from '../../packages/core/src/run-tasks/reviewed-lifecycle.js';
import { mockProvider } from '../contract/fixtures/mock-providers.js';
import type { StageStatsMap, MultiModelConfig, TaskSpec, AgentType, Provider } from '../../packages/core/src/types.js';

function makeConfig(opts?: { defaultTools?: 'none' | 'readonly' | 'no-shell' | 'full' }): MultiModelConfig {
  return {
    agents: {
      standard: {
        type: 'openai-compatible',
        model: 'gpt-5',
        baseUrl: 'http://mock.local',
        apiKey: 'mock',
      },
      complex: {
        type: 'openai-compatible',
        model: 'gpt-5.2',
        baseUrl: 'http://mock.local',
        apiKey: 'mock',
      },
    },
    defaults: {
      timeoutMs: 300_000,
      stallTimeoutMs: 600_000,
      maxCostUSD: 10,
      tools: opts?.defaultTools ?? 'full',
      sandboxPolicy: 'cwd-only',
    },
    server: {
      bind: '127.0.0.1',
      port: 7337,
      auth: { tokenFile: '/tmp/mock-token' },
      limits: {
        maxBodyBytes: 1_000_000,
        batchTtlMs: 300_000,
        idleProjectTimeoutMs: 3_600_000,
        clarificationTimeoutMs: 300_000,
        projectCap: 10,
        maxBatchCacheSize: 10,
        maxContextBlockBytes: 100_000,
        maxContextBlocksPerProject: 10,
        shutdownDrainMs: 5_000,
      },
      autoUpdateSkills: false,
    },
  };
}

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
    expect(stats.verifying.modelFamily).toBe('openai');
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

// Integration tests — verify that executeReviewedLifecycle actually
// wires stageStats into the returned RunResult, not just the unit helpers.
describe('executeReviewedLifecycle wires stageStats into RunResult', () => {
  it('populates stageStats when reviewPolicy=off and no file artifacts', async () => {
    const config = makeConfig();
    const task: TaskSpec = { prompt: 'test', reviewPolicy: 'off' };
    const resolved: { slot: AgentType; provider: Provider; capabilityOverride: boolean } = {
      slot: 'standard',
      provider: {
        name: 'mock-standard',
        config: config.agents.standard,
        run: mockProvider({ stage: 'ok', output: 'done' }).run,
      },
      capabilityOverride: false,
    };

    const r = await executeReviewedLifecycle(task, resolved, config, 0);

    // stageStats must be defined on the returned RunResult
    expect(r.stageStats).toBeDefined();
    const s = r.stageStats!;

    // implementing stage was entered (the provider ran)
    expect(s.implementing.entered).toBe(true);
    expect(s.implementing.durationMs).toBeGreaterThanOrEqual(0);
    expect(s.implementing.model).toBeTruthy();
    expect(s.implementing.agentTier).toBeTruthy();

    // Stages not entered have entered=false and null sub-fields (R4)
    expect(s.spec_review.entered).toBe(false);
    expect(s.spec_review.verdict).toBeNull();
    expect(s.spec_review.roundsUsed).toBeNull();

    expect(s.spec_rework.entered).toBe(false);
    expect(s.spec_rework.durationMs).toBeNull();
    expect(s.spec_rework.costUSD).toBeNull();

    expect(s.quality_review.entered).toBe(false);
    expect(s.quality_review.verdict).toBeNull();

    expect(s.quality_rework.entered).toBe(false);
    expect(s.quality_rework.durationMs).toBeNull();

    expect(s.diff_review.entered).toBe(false);
    expect(s.diff_review.verdict).toBeNull();

    expect(s.committing.entered).toBe(false);
    expect(s.committing.durationMs).toBeNull();

    // verifying is not entered for non-artifact tasks
    expect(s.verifying.entered).toBe(false);
    expect(s.verifying.outcome).toBeNull();
    expect(s.verifying.skipReason).toBeNull();
  });

  it('populates stageStats when provider returns incomplete', async () => {
    const config = makeConfig();
    const task: TaskSpec = { prompt: 'test', reviewPolicy: 'off' };
    const resolved: { slot: AgentType; provider: Provider; capabilityOverride: boolean } = {
      slot: 'standard',
      provider: {
        name: 'mock-standard',
        config: config.agents.standard,
        run: mockProvider({ stage: 'incomplete', output: 'partial work' }).run,
      },
      capabilityOverride: false,
    };

    const r = await executeReviewedLifecycle(task, resolved, config, 0);

    expect(r.stageStats).toBeDefined();
    const s = r.stageStats!;

    // implementing stage was still entered even though result was incomplete
    expect(s.implementing.entered).toBe(true);
    expect(s.implementing.durationMs).toBeGreaterThanOrEqual(0);
    expect(s.implementing.model).toBeTruthy();

    // stages not entered remain entered=false
    expect(s.spec_review.entered).toBe(false);
    expect(s.spec_rework.entered).toBe(false);
    expect(s.quality_review.entered).toBe(false);
    expect(s.diff_review.entered).toBe(false);
    expect(s.committing.entered).toBe(false);
  });

  it('records verifying stage when autoCommit is true and verifyCommand is set', async () => {
    const config = makeConfig();
    const task: TaskSpec = {
      prompt: 'test',
      reviewPolicy: 'off',
      autoCommit: true,
      verifyCommand: ['true'],
    };
    const resolved: { slot: AgentType; provider: Provider; capabilityOverride: boolean } = {
      slot: 'standard',
      provider: {
        name: 'mock-standard',
        config: config.agents.standard,
        run: mockProvider({ stage: 'ok', output: 'done' }).run,
      },
      capabilityOverride: false,
    };

    const r = await executeReviewedLifecycle(task, resolved, config, 0);

    expect(r.stageStats).toBeDefined();
    const s = r.stageStats!;
    expect(s.verifying.entered).toBe(true);
    expect(s.verifying.outcome).toBe('passed');
    expect(s.verifying.durationMs).toBeGreaterThanOrEqual(0);
    expect(s.verifying.model).toBeTruthy();
    expect(s.verifying.agentTier).toBeTruthy();
  });

  it('records terminal as the final heartbeat stage', async () => {
    const config = makeConfig();
    const task: TaskSpec = { prompt: 'test', reviewPolicy: 'off' };
    const resolved: { slot: AgentType; provider: Provider; capabilityOverride: boolean } = {
      slot: 'standard',
      provider: {
        name: 'mock-standard',
        config: config.agents.standard,
        run: mockProvider({ stage: 'ok', output: 'done' }).run,
      },
      capabilityOverride: false,
    };

    const r = await executeReviewedLifecycle(task, resolved, config, 0);

    // After lifecycle completion, stageStats must be present
    // and implementing stage must have been entered+closed
    expect(r.stageStats).toBeDefined();
    expect(r.stageStats!.implementing.entered).toBe(true);
    expect(r.stageStats!.implementing.durationMs).toBeGreaterThanOrEqual(0);
  });

  it('all 8 stage entries are present', async () => {
    const config = makeConfig();
    const task: TaskSpec = { prompt: 'test', reviewPolicy: 'off' };
    const resolved: { slot: AgentType; provider: Provider; capabilityOverride: boolean } = {
      slot: 'standard',
      provider: {
        name: 'mock-standard',
        config: config.agents.standard,
        run: mockProvider({ stage: 'ok', output: 'done' }).run,
      },
      capabilityOverride: false,
    };

    const r = await executeReviewedLifecycle(task, resolved, config, 0);

    const keys = Object.keys(r.stageStats ?? {}) as Array<keyof StageStatsMap>;
    expect(keys).toHaveLength(8);
    expect(keys).toContain('implementing');
    expect(keys).toContain('verifying');
    expect(keys).toContain('spec_review');
    expect(keys).toContain('spec_rework');
    expect(keys).toContain('quality_review');
    expect(keys).toContain('quality_rework');
    expect(keys).toContain('diff_review');
    expect(keys).toContain('committing');
  });
});
