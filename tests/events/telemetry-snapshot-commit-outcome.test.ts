import type { TurnResult } from '../../packages/core/src/types/run-result.js';
import type { PipelineResult } from '../../packages/core/src/unified/two-phase-pipeline.js';
import { buildEnvelopeSnapshot } from '../../packages/server/src/application/telemetry-snapshot.js';
import { toWireRecord } from '../../packages/core/src/events/to-wire-record.js';

/**
 * Telemetry must report what the engine actually did, not a placeholder.
 *
 * `buildEnvelopeSnapshot` hardcoded `commitSha: null` and filled `realFilesChanged` from the
 * worker's SELF-REPORT. Both facts were sitting on the `PipelineResult` it was handed:
 * `commitSha` (captured the instant `commitAll` creates the commit) and `filesChangedFromGit`
 * (`git diff --name-only` across it).
 *
 * The result was that every write-route execution reported "no commit" and a file count taken
 * from the runner's claim rather than from git. Nothing failed, because the only existing
 * assertion about these fields — `envelope-shape-guard` — checks that the KEYS exist, not that
 * they carry anything. A hardcoded null satisfies a shape guard perfectly.
 */
const turn = (filesWritten: string[]): TurnResult => ({
  output: '',
  usage: { inputTokens: 10, outputTokens: 5, cachedReadTokens: 0, cachedNonReadTokens: 0 },
  costUSD: 0.01,
  turns: 1,
  durationMs: 5,
  terminationReason: 'ok',
  filesWritten,
  usedShell: false,
  toolCalls: [],
  sandboxDenialCount: 0,
});

function snapshotOf(over: Partial<PipelineResult>) {
  const result = {
    status: 'done',
    implementerTurn: turn(['src/worker-said-this.ts']),
    reviewerTurn: null,
    ...over,
  } as unknown as PipelineResult;
  return buildEnvelopeSnapshot(
    'exec-1', 'delegate', result, 'standard', 'complex', 'none',
    'claude-sonnet-5', 'gpt-5.6', 'claude-opus-5', 'claude-code', '/repo', 100,
  );
}

describe('telemetry snapshot carries the real commit outcome', () => {
  it('reports the commit SHA the pipeline captured', () => {
    const envelope = snapshotOf({ commitSha: 'abc123def456', filesChangedFromGit: ['src/a.ts'] });
    expect(envelope.commitSha).toBe('abc123def456');
  });

  it('reports git-derived changes as realFilesChanged, not the worker self-report', () => {
    const envelope = snapshotOf({
      commitSha: 'abc123',
      filesChangedFromGit: ['src/a.ts', 'src/b.ts'],
    });
    // The two fields answer different questions and must not both echo the runner.
    expect(envelope.filesWritten).toEqual(['src/worker-said-this.ts']);
    expect(envelope.realFilesChanged).toEqual(['src/a.ts', 'src/b.ts']);

    // …and that is the set the wire record counts.
    const wire = toWireRecord(envelope, {
      toolMode: 'full', implementerModel: 'claude-sonnet-5', implementerTier: 'standard', mainModelFamily: 'claude' as const,
    });
    expect(wire.filesWrittenCount).toBe(2);
  });

  it('falls back to the self-report only when git has no answer', () => {
    // A read route, a non-git target, or a write route that changed nothing: `filesChangedFromGit`
    // is null and there is no better source than what the runner reported.
    const envelope = snapshotOf({ commitSha: null, filesChangedFromGit: null });
    expect(envelope.commitSha).toBeNull();
    expect(envelope.realFilesChanged).toEqual(['src/worker-said-this.ts']);
  });
});
