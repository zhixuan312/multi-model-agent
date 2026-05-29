import { describe, it, expect } from 'bun:test';
import { TaskEnvelopeStore } from '../../packages/core/src/events/task-envelope.js';
import { toWireRecord } from '../../packages/core/src/events/to-wire-record.js';

// The 5 fields that A+B+C is permitted to change between pre-4.7.8 and
// post-4.7.8 for an otherwise-identical lifecycle execution. Anything
// outside this set differing indicates accidental blast-radius spread.
const ALLOWED_DIFF_PATHS = new Set([
  'terminalStatus',
  'workerStatus',
  'errorCode',
  // annotating-stage outcome + skipReason — addressed at stages[i].outcome/skipReason
  // where stages[i].name === 'annotating'
  'stages[annotating].outcome',
  'stages[annotating].skipReason',
]);

// Build an envelope. The wire-side `terminalStatus` is computed from the
// envelope's `status` + `structuredError.code`; we don't pass terminalStatus
// directly — see mapStatusToWire() in to-wire-record.ts.
function buildEnvelope(opts: { status: 'done' | 'failed'; errorCode: string | null; annotatingOutcome: 'transformed' | 'skipped' }) {
  const store = TaskEnvelopeStore.create({
    taskId: 'fixture-1', batchId: 'b1', taskIndex: 0,
    route: 'delegate', agentType: 'standard',
    client: 'claude-code', mainModel: 'claude-opus-4-7', cwd: '/tmp',
    reviewPolicy: 'full',
  });
  store.startStage('implementing', { model: 'claude-haiku-4-5', tier: 'standard', round: 1 });
  store.completeStage('implementing', 1, {
    outcome: 'advance', durationMs: 1000, costUSD: 0.01,
    inputTokens: 100, outputTokens: 50, cachedReadTokens: 0, cachedNonReadTokens: 0,
    turnsUsed: 2, toolCallCount: 3, filesReadCount: 1, filesWrittenCount: 1,
  });
  store.startStage('reviewing', { model: 'claude-haiku-4-5', tier: 'standard', round: 1 });
  store.completeStage('reviewing', 1, {
    outcome: 'advance', durationMs: 500, costUSD: 0.005, verdict: 'approved',
    inputTokens: 50, outputTokens: 25, cachedReadTokens: 0, cachedNonReadTokens: 0,
    turnsUsed: 1, toolCallCount: 0, filesReadCount: 0, filesWrittenCount: 0,
  });
  store.startStage('annotating', { model: 'claude-haiku-4-5', tier: 'standard', round: 1 });
  store.completeStage('annotating', 1, {
    outcome: opts.annotatingOutcome === 'transformed' ? 'advance' : 'skipped',
    durationMs: 100, costUSD: 0.001,
    inputTokens: 10, outputTokens: 5, cachedReadTokens: 0, cachedNonReadTokens: 0,
    turnsUsed: 1, toolCallCount: 0, filesReadCount: 0, filesWrittenCount: 0,
  });
  store.startStage('committing', { model: 'claude-haiku-4-5', tier: 'standard', round: 1 });
  store.completeStage('committing', 1, {
    outcome: 'advance', durationMs: 50, costUSD: 0,
    inputTokens: 0, outputTokens: 0, cachedReadTokens: 0, cachedNonReadTokens: 0,
    turnsUsed: 0, toolCallCount: 1, filesReadCount: 0, filesWrittenCount: 1,
    filesCommittedCount: 1, branchCreated: false,
    verdict: 'passed',
  });
  store.seal({
    status: opts.status,
    terminalAt: '2026-05-19T00:00:00Z',
    stopReason: 'normal',
    realFilesChanged: ['x.ts'],
    structuredError: opts.errorCode ? { code: opts.errorCode, message: 'fixture' } : null,
    errorCode: opts.errorCode as never,
  });
  return store.snapshot();
}

function flatten(obj: unknown, prefix = ''): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  if (obj === null || obj === undefined) { out[prefix || '$'] = obj; return out; }
  if (Array.isArray(obj)) {
    // For arrays-of-stage-objects, key on stage.name so renumbered stages
    // don't show up as diffs.
    if (obj.length > 0 && typeof obj[0] === 'object' && obj[0] !== null && 'name' in (obj[0] as object)) {
      for (const item of obj) {
        const name = (item as { name: string }).name;
        Object.assign(out, flatten(item, `${prefix}[${name}]`));
      }
    } else {
      obj.forEach((v, i) => Object.assign(out, flatten(v, `${prefix}[${i}]`)));
    }
    return out;
  }
  if (typeof obj === 'object') {
    for (const [k, v] of Object.entries(obj as Record<string, unknown>)) {
      Object.assign(out, flatten(v, prefix ? `${prefix}.${k}` : k));
    }
    return out;
  }
  out[prefix] = obj;
  return out;
}

describe('wire-record blast radius — only status fields differ pre/post A+B+C', () => {
  it('pre-change vs post-change wire output diff is a subset of ALLOWED_DIFF_PATHS', () => {
    // PRE: how a row would have looked before A+B+C — envelope sealed
    // with status='failed' + structuredError code, the wire then projects
    // terminalStatus='error' / workerStatus='failed' via mapStatusToWire.
    // Annotating was skipped because of the hard worker-self-assessment precondition.
    const pre = buildEnvelope({
      status: 'failed',
      errorCode: 'review_quality_findings_unresolved',
      annotatingOutcome: 'skipped',
    });
    // POST: how the SAME execution now looks after A+B+C — envelope
    // sealed with status='done', wire projects terminalStatus='ok' /
    // workerStatus='done', annotating ran and transformed.
    const post = buildEnvelope({
      status: 'done',
      errorCode: null,
      annotatingOutcome: 'transformed',
    });

    const cfg = { toolMode: 'full' as const, implementerModel: 'claude-haiku-4-5', implementerTier: 'standard' as const, mainModelFamily: 'claude' as const };
    const wirePre = toWireRecord(pre, cfg);
    const wirePost = toWireRecord(post, cfg);

    const flatPre = flatten(wirePre);
    const flatPost = flatten(wirePost);
    const allKeys = new Set([...Object.keys(flatPre), ...Object.keys(flatPost)]);

    const diffs: string[] = [];
    for (const k of allKeys) {
      if (JSON.stringify(flatPre[k]) !== JSON.stringify(flatPost[k])) diffs.push(k);
    }

    // Strip variable noise (eventId, timestamps) — these are not stable across runs
    // even with the same input envelope, so we exclude them from the assertion.
    const NOISE = new Set(['eventId', 'occurredAt', 'sentAt']);
    const meaningfulDiffs = diffs.filter((d) => !NOISE.has(d));

    for (const d of meaningfulDiffs) {
      expect(ALLOWED_DIFF_PATHS.has(d), `unexpected diff at path "${d}" — pre=${JSON.stringify(flatPre[d])} post=${JSON.stringify(flatPost[d])}`).toBe(true);
    }
    // Sanity: at least one allowed field actually differs (otherwise the
    // fixture is malformed and the assertion is vacuous).
    expect(meaningfulDiffs.length).toBeGreaterThan(0);
  });
});
