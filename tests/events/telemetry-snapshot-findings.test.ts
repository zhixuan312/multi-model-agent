import { describe, it, expect } from 'vitest';
import type { PipelineResult } from '../../packages/core/src/unified/two-phase-pipeline.js';
import type { TurnResult } from '../../packages/core/src/types/run-result.js';
import { buildEnvelopeSnapshot } from '../../packages/server/src/application/telemetry-snapshot.js';
import { toWireRecord } from '../../packages/core/src/events/to-wire-record.js';

/**
 * End-to-end for the signal that went dark at 4.8.0.
 *
 * `reviewer-findings.test.ts` proves the extractor; this proves the extractor is
 * actually WIRED — that a reviewer's findings survive snapshot → wire record.
 * The old code passed every extractor test it could have had, because the bug
 * was a hardcoded `findings: []` at the one call site.
 */

const turn = (over: Partial<TurnResult> = {}): TurnResult => ({
  output: 'answer',
  usage: { inputTokens: 100, outputTokens: 50, cachedReadTokens: 0, cachedNonReadTokens: 0 },
  costUSD: 0.02,
  turns: 2,
  durationMs: 1000,
  terminationReason: 'ok',
  filesWritten: [],
  usedShell: false,
  toolCalls: [],
  sandboxDenialCount: 0,
  ...over,
});

function snapshot(over: Partial<PipelineResult>, type = 'audit' as const, cancelled = false) {
  const result = {
    status: 'done',
    implementerOutput: 'x',
    implementerTurn: turn(),
    reviewerOutput: null,
    reviewerRaw: null,
    reviewerTurn: null,
    reviewerParseError: null,
    sessions: { implementer: {}, reviewer: null },
    cost: { implementerUsd: 0.02, reviewerUsd: null },
    worktree: null,
    dirtyAtDispatch: false,
    filesChangedFromGit: null,
    commitSha: null,
    contractNote: null,
    ...over,
  } as unknown as PipelineResult;

  return buildEnvelopeSnapshot(
    'task-1', type, result,
    'standard', 'complex', 'reviewed',
    'claude-sonnet-4-6', 'claude-opus-4-7', 'claude-opus-4-7',
    'claude-code', '/tmp', 5000, [], cancelled,
  );
}

const wireOf = (env: ReturnType<typeof snapshot>) =>
  toWireRecord(env, {
    toolMode: 'readonly',
    implementerModel: 'claude-sonnet-4-6',
    implementerTier: 'standard',
    mainModelFamily: 'claude',
  });

describe('the envelope snapshot carries the reviewer`s findings', () => {
  const reviewed = () =>
    snapshot({
      status: 'done_with_concerns',
      reviewerTurn: turn({ costUSD: 0.05 }),
      reviewerOutput: {
        criteriaCovered: ['c1'],
        findings: [
          { weight: 'critical', category: 'security', claim: 'token logged', evidence: 'a.ts:1', suggestion: 'redact' },
          { weight: 'high', category: 'security', claim: 'no authz', evidence: 'b.ts:2', suggestion: 'add check' },
          { weight: 'low', category: 'style', claim: 'naming', evidence: 'c.ts:3', suggestion: '' },
        ],
      },
    });

  it('reports the count instead of a permanent zero', () => {
    // Fails against the hardcoded `findings: []` — this is the whole regression.
    expect(reviewed().findings).toHaveLength(3);
    expect(wireOf(reviewed()).concernCount).toBe(3);
  });

  it('reports the severity histogram the dashboard buckets on', () => {
    expect(wireOf(reviewed()).findingsBySeverity).toEqual({ critical: 1, high: 1, medium: 0, low: 1 });
  });

  it('puts the reviewer`s categories on the review stage', () => {
    const review = wireOf(reviewed()).stages.find((s) => s.name === 'review');
    expect(review).toBeDefined();
    expect((review as { concernCategories: string[] }).concernCategories).toEqual(['security', 'style']);
  });

  it('escalates the verdict when the reviewer raised critical or high findings', () => {
    // `approved` over a critical finding is the reading that made the review
    // stage look uniformly happy no matter what came back.
    const review = wireOf(reviewed()).stages.find((s) => s.name === 'review');
    expect((review as { verdict: string }).verdict).toBe('changes_required');
  });

  it('says changes are not required when only low findings came back', () => {
    const env = snapshot({
      status: 'done_with_concerns',
      reviewerTurn: turn(),
      reviewerOutput: { findings: [{ weight: 'low', category: 'style', claim: 'c', evidence: 'e' }] },
    });
    const review = wireOf(env).stages.find((s) => s.name === 'review');
    expect((review as { verdict: string }).verdict).toBe('concerns');
  });

  it('marks a reviewed findings-route with nothing found as clean, not unmeasured', () => {
    const env = snapshot({ reviewerTurn: turn(), reviewerOutput: { criteriaCovered: ['c1'], findings: [] } });
    expect(wireOf(env).findingsOutcome).toBe('clean');
    expect(wireOf(env).concernCount).toBe(0);
  });

  it('marks a route that reports no findings at all as not_applicable', () => {
    // delegate's refiner schema has no findings array; zero there is an absence
    // of measurement, and calling it `clean` would be a false assurance.
    const env = snapshot(
      { reviewerTurn: turn(), reviewerOutput: { status: 'done', notes: '' } },
      'delegate' as never,
    );
    expect(wireOf(env).findingsOutcome).toBe('not_applicable');
  });

  it('marks an unreviewed run as not_applicable even on a findings route', () => {
    expect(wireOf(snapshot({})).findingsOutcome).toBe('not_applicable');
  });
});

describe('the envelope snapshot carries sandbox refusals', () => {
  it('sums the denials the confinement hook counted', () => {
    const env = snapshot({
      implementerTurn: turn({ sandboxDenialCount: 3 }),
      reviewerTurn: turn({ sandboxDenialCount: 1 }),
      reviewerOutput: { findings: [] },
    });
    expect(env.sandboxViolationCount).toBe(4);
    expect(wireOf(env).sandboxViolationCount).toBe(4);
  });

  it('reports null when no runner could observe a refusal', () => {
    // Codex confines writes in the OS sandbox, which refuses without telling us.
    // A 0 would claim the worker was watched and behaved.
    const env = snapshot({ implementerTurn: turn({ sandboxDenialCount: null }) });
    expect(env.sandboxViolationCount).toBeNull();
    expect(wireOf(env).sandboxViolationCount).toBeNull();
  });

  it('reports the measured half of a mixed task rather than discarding it', () => {
    const env = snapshot({
      implementerTurn: turn({ sandboxDenialCount: 2 }),
      reviewerTurn: turn({ sandboxDenialCount: null }),
      reviewerOutput: { findings: [] },
    });
    expect(env.sandboxViolationCount).toBe(2);
  });

  it('reports 0 as a real measurement, distinct from null', () => {
    expect(snapshot({}).sandboxViolationCount).toBe(0);
  });
});

describe('a cancelled run is not reported as an engine failure', () => {
  it('reports terminalStatus=cancelled when the caller aborted', () => {
    const env = snapshot({ status: 'failed', failureReason: { code: 'aborted', message: 'x' } } as never, 'audit', true);
    const wire = wireOf(env);
    expect(wire.terminalStatus).toBe('cancelled');
    expect(wire.workerStatus).toBe('cancelled');
  });

  it('still reports an uncancelled failure as an error', () => {
    const env = snapshot({ status: 'failed', failureReason: { code: 'pipeline_failed', message: 'x' } } as never);
    expect(wireOf(env).terminalStatus).toBe('error');
  });
});

describe('output-format drift is reported', () => {
  /**
   * `validationWarnings` was hardcoded `[]`, so the one number that says "our
   * reviewer prompt produces output the schema cannot parse" has never left the
   * engine. It is a prompt/schema problem rather than a model problem, and
   * nothing else in the telemetry exposes it.
   */
  it('emits a warning when the reviewer output could not be parsed', () => {
    const env = snapshot({
      status: 'done_with_concerns',
      reviewerTurn: turn(),
      reviewerOutput: null,
      reviewerParseError: 'Unexpected token } in JSON at position 402',
    });
    expect(env.validationWarnings).toHaveLength(1);
    expect(env.validationWarnings[0]!.rule).toBe('reviewer_output_unparseable');
    expect(wireOf(env).validation_warnings?.[0]?.rule).toBe('reviewer_output_unparseable');
  });

  it('groups on a stable rule key rather than the raw error text', () => {
    // A Zod error is long and unique per run; using it as the key would make
    // every warning its own bucket and the panel unreadable.
    const a = snapshot({ reviewerTurn: turn(), reviewerOutput: null, reviewerParseError: 'error A at 1' });
    const b = snapshot({ reviewerTurn: turn(), reviewerOutput: null, reviewerParseError: 'totally different error B at 999' });
    expect(a.validationWarnings[0]!.rule).toBe(b.validationWarnings[0]!.rule);
    expect(a.validationWarnings[0]!.path).not.toBe(b.validationWarnings[0]!.path);
  });

  it('truncates a runaway parse error', () => {
    const env = snapshot({ reviewerTurn: turn(), reviewerOutput: null, reviewerParseError: 'x'.repeat(5000) });
    expect(env.validationWarnings[0]!.path.length).toBeLessThanOrEqual(200);
  });

  it('emits nothing when the reviewer parsed cleanly', () => {
    expect(snapshot({ reviewerTurn: turn(), reviewerOutput: { findings: [] } }).validationWarnings).toEqual([]);
  });

  it('does not report an unparsed review as clean', () => {
    // Pairs with the outcome fix: a review nobody could read is not a clean one.
    const env = snapshot({ reviewerTurn: turn(), reviewerOutput: null, reviewerParseError: 'bad json' });
    expect(wireOf(env).findingsOutcome).toBe('not_applicable');
  });
});
