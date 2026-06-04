import { describe, it, expect } from 'vitest';
import type {
  StageGate, StageDefinition, EntryDecision, WorkerSelfAssessment,
  RouteName, Finding, Citation, Validation,
  ImplementPayload, ReviewPayload, ReworkPayload, CommitPayload,
  AnnotatePayload, ComposePayload, TerminalPayload, RegisterBlockPayload,
} from '../../packages/core/src/lifecycle/stage-io.js';

describe('stage-io types', () => {
  it('StageGate allows three outcomes', () => {
    const a: StageGate = { outcome: 'advance', payload: null,  telemetry: zeroTel() };
    const s: StageGate = { outcome: 'skip',    payload: null,  comment: 'why',     telemetry: zeroTel() };
    const h: StageGate = { outcome: 'halt',    payload: null,  comment: 'broken',  telemetry: zeroTel() };
    expect([a.outcome, s.outcome, h.outcome]).toEqual(['advance', 'skip', 'halt']);
  });

  it('WorkerSelfAssessment is binary', () => {
    const ok: WorkerSelfAssessment = 'done';
    const ko: WorkerSelfAssessment = 'failed';
    // @ts-expect-error no third value
    const bad: WorkerSelfAssessment = 'done_with_concerns';
    expect([ok, ko]).toEqual(['done', 'failed']);
  });

  it('Finding has 7 fields incl. source tag', () => {
    const f: Finding = {
      id: 'F1', severity: 'high', category: 'correctness',
      claim: 'x', source: 'reviewer',
    };
    expect(f.source).toBe('reviewer');
  });

  it('ImplementPayload has 8 fields, default-empty for irrelevant route side', () => {
    const writeOnly: ImplementPayload = {
      workerSelfAssessment: 'done', summary: 's',
      filesChanged: ['a.ts'],
      findings: [], citations: [], criteriaSucceeded: [], criteriaErrors: [], sourcesUsed: [],
    };
    expect(writeOnly.filesChanged).toEqual(['a.ts']);
  });

  it('CommitPayload is a tagged union on kind', () => {
    const committed: CommitPayload = {
      kind: 'committed', commitSha: 'abc', commitMessage: 'msg',
      filesChanged: ['a.ts'], authoredAt: '2026-01-01T00:00:00Z',
    };
    const noOp: CommitPayload = { kind: 'no_op', reason: 'no_diff' };
    expect(committed.kind).toBe('committed');
    expect(noOp.kind).toBe('no_op');
  });
});

function zeroTel() {
  return { stageLabel: '', durationMs: 0, costUSD: null, turnsUsed: 0, stopReason: 'normal' as const };
}