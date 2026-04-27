import { describe, it, expect } from 'vitest';
import { buildTaskCompletedEvent } from '../../packages/core/src/telemetry/event-builder.js';
import { TelemetryEvent } from '../../packages/core/src/telemetry/types.js';
import * as fixtures from './fixtures/runresult.js';

function makeCtx(overrides: Partial<Parameters<typeof buildTaskCompletedEvent>[0]> = {}) {
  return {
    route: 'delegate' as const,
    taskSpec: { filePaths: ['a.ts'] },
    runResult: fixtures.HAPPY,
    client: 'claude-code' as const,
    triggeringSkill: 'mma-delegate' as const,
    parentModel: 'claude-sonnet-4-6',
    ...overrides,
  };
}

describe('event-builder v2 — 11 new TaskCompletedEvent fields', () => {
  it('populates all 11 v2 fields with valid values', () => {
    const ev = buildTaskCompletedEvent(makeCtx());
    expect(ev).toMatchObject({
      filesWrittenBucket: expect.any(String),
      c2Promoted: expect.any(Boolean),
      concernCount: expect.any(Number),
      escalationCount: expect.any(Number),
      fallbackCount: expect.any(Number),
      turnCountBucket: expect.any(String),
      stallTriggered: expect.any(Boolean),
      clarificationRequested: expect.any(Boolean),
      parentModelFamily: expect.any(String),
      briefQualityWarningCount: expect.any(Number),
    });
    expect(['done', 'done_with_concerns', 'needs_context', 'blocked', 'failed', 'review_loop_aborted', null])
      .toContain(ev.workerSelfAssessment);
    TelemetryEvent.parse(ev);
  });

  it('filesWrittenBucket from runResult.filesWritten.length', () => {
    const ev = buildTaskCompletedEvent(makeCtx({
      runResult: { ...fixtures.HAPPY, filesWritten: ['a.ts', 'b.ts', 'c.ts'] },
    }));
    expect(ev.filesWrittenBucket).toBe('1-5');
  });

  it('filesWrittenBucket 0 when no files written', () => {
    const ev = buildTaskCompletedEvent(makeCtx({
      runResult: { ...fixtures.HAPPY, filesWritten: [] },
    }));
    expect(ev.filesWrittenBucket).toBe('0');
  });

  it('c2Promoted from terminationReason.wasPromoted', () => {
    const ev = buildTaskCompletedEvent(makeCtx({
      runResult: {
        ...fixtures.HAPPY,
        terminationReason: { cause: 'finished', turnsUsed: 3, hasFileArtifacts: true, usedShell: false, workerSelfAssessment: 'done', wasPromoted: true },
      },
    }));
    expect(ev.c2Promoted).toBe(true);
  });

  it('c2Promoted false when terminationReason.wasPromoted is false', () => {
    const ev = buildTaskCompletedEvent(makeCtx());
    expect(ev.c2Promoted).toBe(false);
  });

  it('c2Promoted false when terminationReason is a string', () => {
    const ev = buildTaskCompletedEvent(makeCtx({ runResult: fixtures.COST_EXCEEDED }));
    expect(ev.c2Promoted).toBe(false);
  });

  it('workerSelfAssessment from terminationReason', () => {
    const ev = buildTaskCompletedEvent(makeCtx({
      runResult: {
        ...fixtures.HAPPY,
        terminationReason: { cause: 'finished', turnsUsed: 3, hasFileArtifacts: true, usedShell: false, workerSelfAssessment: 'needs_context', wasPromoted: false },
      },
    }));
    expect(ev.workerSelfAssessment).toBe('needs_context');
  });

  it('workerSelfAssessment null when not provided', () => {
    const ev = buildTaskCompletedEvent(makeCtx({
      runResult: {
        ...fixtures.HAPPY,
        terminationReason: { cause: 'finished', turnsUsed: 3, hasFileArtifacts: true, usedShell: false, workerSelfAssessment: null, wasPromoted: false },
      },
    }));
    expect(ev.workerSelfAssessment).toBeNull();
  });

  it('concernCount from runResult.concerns length', () => {
    const ev = buildTaskCompletedEvent(makeCtx({ runResult: fixtures.WITH_CONCERNS }));
    expect(ev.concernCount).toBe(1);
  });

  it('concernCount 0 when no concerns', () => {
    const ev = buildTaskCompletedEvent(makeCtx());
    expect(ev.concernCount).toBe(0);
  });

  it('escalationCount = distinct providers - 1', () => {
    const ev = buildTaskCompletedEvent(makeCtx({ runResult: fixtures.ESCALATED }));
    // ESCALATED has claude + openai → 2 distinct → escalationCount = 1
    expect(ev.escalationCount).toBe(1);
  });

  it('escalationCount 0 when single provider', () => {
    const ev = buildTaskCompletedEvent(makeCtx());
    expect(ev.escalationCount).toBe(0);
  });

  it('fallbackCount from fallbackOverrides length', () => {
    const ev = buildTaskCompletedEvent(makeCtx({ runResult: fixtures.FALLBACK }));
    expect(ev.fallbackCount).toBe(1);
  });

  it('fallbackCount 0 when no fallbackOverrides', () => {
    const ev = buildTaskCompletedEvent(makeCtx());
    expect(ev.fallbackCount).toBe(0);
  });

  it('turnCountBucket from runResult.turns', () => {
    const ev = buildTaskCompletedEvent(makeCtx({
      runResult: { ...fixtures.HAPPY, turns: 3 },
    }));
    expect(ev.turnCountBucket).toBe('1-3');
  });

  it('turnCountBucket for higher turn counts', () => {
    const ev = buildTaskCompletedEvent(makeCtx({
      runResult: { ...fixtures.HAPPY, turns: 15 },
    }));
    expect(ev.turnCountBucket).toBe('11-30');
  });

  it('stallTriggered from runResult.stallTriggered', () => {
    const ev = buildTaskCompletedEvent(makeCtx({
      runResult: { ...fixtures.HAPPY, stallTriggered: true },
    }));
    expect(ev.stallTriggered).toBe(true);
  });

  it('stallTriggered false by default', () => {
    const ev = buildTaskCompletedEvent(makeCtx());
    expect(ev.stallTriggered).toBe(false);
  });

  it('clarificationRequested from lifecycleClarificationRequested', () => {
    const ev = buildTaskCompletedEvent(makeCtx({
      runResult: { ...fixtures.HAPPY, lifecycleClarificationRequested: true },
    }));
    expect(ev.clarificationRequested).toBe(true);
  });

  it('clarificationRequested false by default', () => {
    const ev = buildTaskCompletedEvent(makeCtx());
    expect(ev.clarificationRequested).toBe(false);
  });

  it('parentModelFamily derived from parentModel', () => {
    const ev = buildTaskCompletedEvent(makeCtx({ parentModel: 'claude-sonnet-4-6' }));
    expect(ev.parentModelFamily).toBe('claude');
  });

  it('parentModelFamily other when parentModel is null', () => {
    const ev = buildTaskCompletedEvent(makeCtx({ parentModel: null }));
    expect(ev.parentModelFamily).toBe('other');
  });

  it('briefQualityWarningCount from briefQualityWarnings length', () => {
    const ev = buildTaskCompletedEvent(makeCtx({
      runResult: {
        ...fixtures.HAPPY,
        briefQualityWarnings: [
          { type: 'too_broad' as const, message: 'too broad' },
          { type: 'too_short' as const, message: 'too short' },
        ],
      },
    }));
    expect(ev.briefQualityWarningCount).toBe(2);
  });

  it('briefQualityWarningCount 0 when no warnings', () => {
    const ev = buildTaskCompletedEvent(makeCtx());
    expect(ev.briefQualityWarningCount).toBe(0);
  });
});
