import { describe, it, expect } from 'vitest';
import {
  buildTaskCompletedEvent,
  buildSessionStartedEvent,
  buildInstallChangedEvent,
  buildSkillInstalledEvent,
} from '../../packages/core/src/telemetry/event-builder.js';
import { TelemetryEvent } from '../../packages/core/src/telemetry/types.js';
import * as fixtures from './fixtures/runresult.js';

function makeCtx(overrides: Partial<Parameters<typeof buildTaskCompletedEvent>[0]> = {}) {
  return {
    route: 'delegate' as const,
    taskSpec: { filePaths: ['a.ts'] },
    runResult: fixtures.HAPPY,
    client: 'claude-code' as const,
    triggeringSkill: 'mma-delegate' as const,
    parentModel: null,
    ...overrides,
  };
}

describe('event-builder — produces R1–R5-valid events for every route × outcome', () => {
  for (const fx of fixtures.ALL) {
    it(`route=${fx.route}, terminal=${fx.terminal} → valid event (${fx.name})`, () => {
      const ctx = makeCtx({ route: fx.route, runResult: fx.input });
      const event = buildTaskCompletedEvent(ctx);
      const parsed = TelemetryEvent.parse(event);
      expect(parsed).toBeTruthy();
    });
  }

  it('costBucket 0.005 → <$0.01', () => {
    const ev = buildTaskCompletedEvent(makeCtx({
      runResult: { ...fixtures.HAPPY, usage: { inputTokens: 100, outputTokens: 50, totalTokens: 150, costUSD: 0.005 } },
    }));
    expect(ev.costBucket).toBe('<$0.01');
  });

  it('terminationReason="cost_ceiling" (top-level) → terminalStatus=cost_exceeded', () => {
    const ev = buildTaskCompletedEvent(makeCtx({ runResult: fixtures.COST_EXCEEDED }));
    expect(ev.terminalStatus).toBe('cost_exceeded');
  });

  it('terminationReason missing → terminalStatus=incomplete', () => {
    const ev = buildTaskCompletedEvent(makeCtx({ runResult: fixtures.NO_TERMINATION_REASON }));
    expect(ev.terminalStatus).toBe('incomplete');
  });

  it('terminationReason="round_cap" → terminalStatus=incomplete', () => {
    const ev = buildTaskCompletedEvent(makeCtx({ runResult: fixtures.ROUND_CAP }));
    expect(ev.terminalStatus).toBe('incomplete');
  });

  it('verdict=approved + concerns of matching source → upgraded to "concerns"', () => {
    const ev = buildTaskCompletedEvent(makeCtx({ runResult: fixtures.WITH_CONCERNS }));
    expect(ev.stages.spec_review.verdict).toBe('concerns');
  });

  it('topToolNames takes top 5 distinct names, normalizes snake_case, maps unknown to other', () => {
    const ev = buildTaskCompletedEvent(makeCtx({
      runResult: {
        ...fixtures.HAPPY,
        toolCalls: ['read_file', 'read_file', 'run_shell', 'editFile', 'grep', 'glob', 'listFiles', 'listFiles', 'foo_bar'],
      },
    }));
    const names = ev.topToolNames;
    // Permissive vocabulary (0.3.0+): top-20 by count, no allowlist filter.
    // snake_case → camelCase normalization still happens (read_file → readFile,
    // list_files → listFiles), so those collapse with any camelCase counterparts.
    // Tool names that pass BoundedIdentifier shape — including 'foo_bar' — pass
    // through unchanged; they are NOT collapsed to 'other'.
    expect(names).toContain('readFile');
    expect(names).toContain('listFiles');
    expect(names.length).toBeLessThanOrEqual(20);
    expect(names).toContain('foo_bar'); // shape-valid → passes through (was mapped to 'other' pre-0.3.0)
  });

  it('escalated is true when escalationLog has >1 entries', () => {
    const ev = buildTaskCompletedEvent(makeCtx({ runResult: fixtures.ESCALATED }));
    expect(ev.escalated).toBe(true);
  });

  it('escalated is false when escalationLog has 1 entry', () => {
    const ev = buildTaskCompletedEvent(makeCtx({ runResult: fixtures.HAPPY }));
    expect(ev.escalated).toBe(false);
  });

  it('fallbackTriggered is true when fallbackOverrides is non-empty', () => {
    const ev = buildTaskCompletedEvent(makeCtx({ runResult: fixtures.FALLBACK }));
    expect(ev.fallbackTriggered).toBe(true);
  });

  it('fallbackTriggered is false when no fallbackOverrides', () => {
    const ev = buildTaskCompletedEvent(makeCtx({ runResult: fixtures.HAPPY }));
    expect(ev.fallbackTriggered).toBe(false);
  });

  it('fileCountBucket from taskSpec.filePaths', () => {
    const ev = buildTaskCompletedEvent(makeCtx({ taskSpec: { filePaths: ['a.ts', 'b.ts', 'c.ts'] } }));
    expect(ev.fileCountBucket).toBe('1-5');
  });

  it('fileCountBucket 0 when filePaths is empty', () => {
    const ev = buildTaskCompletedEvent(makeCtx({ taskSpec: { filePaths: [] } }));
    expect(ev.fileCountBucket).toBe('0');
  });

  it('workerStatus from terminationReason.workerSelfAssessment when cause=finished', () => {
    const ev = buildTaskCompletedEvent(makeCtx({
      runResult: {
        ...fixtures.HAPPY,
        terminationReason: { cause: 'finished', turnsUsed: 3, hasFileArtifacts: true, usedShell: false, workerSelfAssessment: 'done_with_concerns', wasPromoted: false },
      },
    }));
    expect(ev.workerStatus).toBe('done_with_concerns');
  });

  it('workerStatus falls back to RunResult.workerStatus', () => {
    const ev = buildTaskCompletedEvent(makeCtx({
      runResult: {
        ...fixtures.HAPPY,
        terminationReason: { cause: 'timeout', turnsUsed: 5, hasFileArtifacts: false, usedShell: true, workerSelfAssessment: null, wasPromoted: false },
        workerStatus: 'blocked',
      },
    }));
    expect(ev.workerStatus).toBe('blocked');
  });

  it('non-reviewed route has spec_review.entered=false', () => {
    const ev = buildTaskCompletedEvent(makeCtx({ route: 'audit', runResult: fixtures.AUDIT_ROUTE_HAPPY }));
    expect(ev.stages.spec_review.entered).toBe(false);
    expect(ev.stages.quality_review.entered).toBe(false);
  });

  it('non-verify route has verifying.outcome=null', () => {
    const ev = buildTaskCompletedEvent(makeCtx({ route: 'audit', runResult: fixtures.AUDIT_ROUTE_HAPPY }));
    expect(ev.stages.verifying.outcome).toBeNull();
  });

  it('implementerModel is allowlisted', () => {
    const ev = buildTaskCompletedEvent(makeCtx());
    expect(ev.implementerModel).toBe('claude-sonnet');
  });

  it('unknown model passes through when shape is valid', () => {
    const ev = buildTaskCompletedEvent(makeCtx({
      runResult: {
        ...fixtures.HAPPY,
        models: { implementer: 'unknown-model-xyz', specReviewer: null, qualityReviewer: null },
      },
    }));
    expect(ev.implementerModel).toBe('unknown-model-xyz');
  });
});

describe('buildSessionStartedEvent', () => {
  it('produces a valid session.started event', () => {
    const ev = buildSessionStartedEvent({
      defaultTier: 'standard',
      diagnosticsEnabled: true,
      autoUpdateSkills: false,
      providersConfigured: ['claude', 'openai-compatible'],
    });
    const parsed = TelemetryEvent.parse(ev);
    expect(parsed).toBeTruthy();
    expect(ev.type).toBe('session.started');
    expect(ev.configFlavor.defaultTier).toBe('standard');
    expect(ev.configFlavor.diagnosticsEnabled).toBe(true);
    expect(ev.configFlavor.autoUpdateSkills).toBe(false);
    expect(ev.providersConfigured).toEqual(['claude', 'openai-compatible']);
  });

  it('deduplicates providers', () => {
    const ev = buildSessionStartedEvent({
      defaultTier: 'complex',
      diagnosticsEnabled: false,
      autoUpdateSkills: true,
      providersConfigured: ['claude', 'claude', 'codex'],
    });
    expect(ev.providersConfigured).toEqual(['claude', 'codex']);
  });
});

describe('buildInstallChangedEvent', () => {
  it('produces a valid install.changed event (upgrade)', () => {
    const ev = buildInstallChangedEvent('3.5.0', '3.6.0', 'upgrade');
    const parsed = TelemetryEvent.parse(ev);
    expect(parsed).toBeTruthy();
    expect(ev.type).toBe('install.changed');
    expect(ev.fromVersion).toBe('3.5.0');
    expect(ev.toVersion).toBe('3.6.0');
    expect(ev.trigger).toBe('upgrade');
  });

  it('fresh_install has null fromVersion', () => {
    const ev = buildInstallChangedEvent(null, '3.6.0', 'fresh_install');
    expect(ev.fromVersion).toBeNull();
    expect(ev.trigger).toBe('fresh_install');
  });

  it('downgrade trigger', () => {
    const ev = buildInstallChangedEvent('3.6.0', '3.5.0', 'downgrade');
    expect(ev.trigger).toBe('downgrade');
  });

  it('rejects non-semver toVersion at parse time', () => {
    const ev = buildInstallChangedEvent(null, 'not.a.version', 'fresh_install');
    const result = TelemetryEvent.safeParse(ev);
    expect(result.success).toBe(false);
  });
});

describe('buildSkillInstalledEvent', () => {
  it('produces a valid skill.installed event', () => {
    const ev = buildSkillInstalledEvent('mma-delegate', 'claude-code');
    const parsed = TelemetryEvent.parse(ev);
    expect(parsed).toBeTruthy();
    expect(ev.type).toBe('skill.installed');
    expect(ev.skill).toBe('mma-delegate');
    expect(ev.client).toBe('claude-code');
  });

  it('rejects "direct" as a skill (not installable)', () => {
    const ev = buildSkillInstalledEvent('direct', 'claude-code');
    const result = TelemetryEvent.safeParse(ev);
    expect(result.success).toBe(false);
  });
});

describe('costBucket boundaries', () => {
  it('$0 when costUSD is 0', () => {
    const ev = buildTaskCompletedEvent(makeCtx({
      runResult: { ...fixtures.HAPPY, usage: { inputTokens: 0, outputTokens: 0, totalTokens: 0, costUSD: 0 } },
    }));
    expect(ev.costBucket).toBe('$0');
  });

  it('$0.01-$0.10 at lower boundary', () => {
    const ev = buildTaskCompletedEvent(makeCtx({
      runResult: { ...fixtures.HAPPY, usage: { inputTokens: 100, outputTokens: 50, totalTokens: 150, costUSD: 0.01 } },
    }));
    expect(ev.costBucket).toBe('$0.01-$0.10');
  });

  it('$1+ for high cost', () => {
    const ev = buildTaskCompletedEvent(makeCtx({
      runResult: { ...fixtures.HAPPY, usage: { inputTokens: 10000, outputTokens: 5000, totalTokens: 15000, costUSD: 5.00 } },
    }));
    expect(ev.costBucket).toBe('$1+');
  });
});

describe('durationBucket boundaries', () => {
  it('<10s for short tasks', () => {
    const ev = buildTaskCompletedEvent(makeCtx({
      runResult: { ...fixtures.HAPPY, durationMs: 5000 },
    }));
    expect(ev.durationBucket).toBe('<10s');
  });

  it('5m-30m for longer tasks', () => {
    const ev = buildTaskCompletedEvent(makeCtx({
      runResult: { ...fixtures.HAPPY, durationMs: 600_000 },
    }));
    expect(ev.durationBucket).toBe('5m-30m');
  });
});

describe('savedCostBucket', () => {
  it('unknown when parentModel is null', () => {
    const ev = buildTaskCompletedEvent(makeCtx({ parentModel: null }));
    expect(ev.savedCostBucket).toBe('unknown');
  });

  it('$0 when parent model costs less', () => {
    const ev = buildTaskCompletedEvent(makeCtx({
      parentModel: 'deepseek-v4-pro',
      runResult: { ...fixtures.HAPPY, usage: { inputTokens: 100, outputTokens: 50, totalTokens: 150, costUSD: 0.50 } },
    }));
    expect(ev.savedCostBucket).toBe('$0');
  });
});

describe('errorCode derivation', () => {
  it('from structuredError.code when present (non-ok terminal)', () => {
    const ev = buildTaskCompletedEvent(makeCtx({
      runResult: {
        ...fixtures.ERROR_API,
        structuredError: { code: 'verify_command_error', message: 'cmd failed' },
      },
    }));
    expect(ev.errorCode).toBe('verify_command_error');
  });

  it('from terminationReason.cause when api_error', () => {
    const ev = buildTaskCompletedEvent(makeCtx({ runResult: fixtures.ERROR_API }));
    expect(ev.errorCode).toBe('api_error');
  });


});

describe('model name normalization for vendor-prefixed models', () => {
  it('normalizes bedrock.claude-haiku-4-5 implementerModel to claude-haiku-4-5', () => {
    const ev = buildTaskCompletedEvent(makeCtx({
      runResult: {
        ...fixtures.HAPPY,
        models: { implementer: 'bedrock.claude-haiku-4-5', specReviewer: null, qualityReviewer: null },
        stageStats: {
          ...fixtures.HAPPY.stageStats,
          implementing: { ...fixtures.HAPPY.stageStats!.implementing!, model: 'bedrock.claude-haiku-4-5' },
        },
      },
    }));
    expect(ev.implementerModel).toBe('claude-haiku-4-5');
    expect(ev.implementerModelFamily).toBe('claude');
    expect(ev.stages.implementing.model).toBe('claude-haiku-4-5');
  });

  it('normalizes azure/gpt-5.5 implementerModel to gpt-5.5', () => {
    const ev = buildTaskCompletedEvent(makeCtx({
      runResult: {
        ...fixtures.HAPPY,
        models: { implementer: 'azure/gpt-5.5', specReviewer: null, qualityReviewer: null },
        stageStats: {
          ...fixtures.HAPPY.stageStats,
          implementing: { ...fixtures.HAPPY.stageStats!.implementing!, model: 'azure/gpt-5.5', modelFamily: 'openai' },
        },
      },
    }));
    expect(ev.implementerModel).toBe('gpt-5.5');
    expect(ev.implementerModelFamily).toBe('openai');
    expect(ev.stages.implementing.model).toBe('gpt-5.5');
  });

  it('normalizes anthropic.claude-haiku-4-5-v1:0 (compound prefix + version suffix)', () => {
    const ev = buildTaskCompletedEvent(makeCtx({
      runResult: {
        ...fixtures.HAPPY,
        models: { implementer: 'anthropic.claude-haiku-4-5-v1:0', specReviewer: null, qualityReviewer: null },
        stageStats: {
          ...fixtures.HAPPY.stageStats,
          implementing: { ...fixtures.HAPPY.stageStats!.implementing!, model: 'anthropic.claude-haiku-4-5-v1:0' },
        },
      },
    }));
    expect(ev.implementerModel).toBe('claude-haiku-4-5');
    expect(ev.implementerModelFamily).toBe('claude');
  });

  it('unknown model passes through when shape is valid after normalization', () => {
    const ev = buildTaskCompletedEvent(makeCtx({
      runResult: {
        ...fixtures.HAPPY,
        models: { implementer: 'unknown-model-xyz', specReviewer: null, qualityReviewer: null },
      },
    }));
    expect(ev.implementerModel).toBe('unknown-model-xyz');
    expect(ev.implementerModelFamily).toBe('other');
  });
});

