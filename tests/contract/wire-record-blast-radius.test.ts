import { describe, it, expect } from 'vitest';
import { TaskEnvelopeStore } from '../fixtures/task-envelope-store.js';
import { toWireRecord } from '../../packages/core/src/events/to-wire-record.js';

// The invariant: for two executions that did the SAME WORK and differ only in how they ended,
// the wire record may differ only in the fields that describe the OUTCOME. Everything else —
// token counts, costs, durations, tool-call rollups, stage models and tiers — describes the work
// and must be identical.
//
// (Framed as "pre/post A+B+C, pre-4.7.8" until this audit. That named a release rather than a
// property, so a reader could not tell what the test was for without finding the release notes.
// The mechanism is unchanged.)
//
// These five are the outcome fields, and nothing else may differ.
const ALLOWED_DIFF_PATHS = new Set([
  'terminalStatus',
  'workerStatus',
  'errorCode',
  // The review stage's verdict follows the run's outcome by design — a `done_with_concerns`
  // run reviews as `concerns`, a failed one as `skipped`/`error`.
  'stages[review].verdict',
  'stages[implementing].outcome',
]);

// This previously built `annotating` and `committing` stages to express the same property.
// Nothing in production has produced either since the lifecycle layer was deleted, so this
// fixture was their ONLY producer — which is what kept their wire-projection branches looking
// covered while they were dead. The property under test is unchanged: changing a run's OUTCOME
// must not ripple into wire fields that describe its work.

// Build an envelope. The wire-side `terminalStatus` is computed from the
// envelope's `status` + `structuredError.code`; we don't pass terminalStatus
// directly — see mapStatusToWire() in to-wire-record.ts.
function buildEnvelope(opts: { status: 'done' | 'failed'; errorCode: string | null }) {
  const store = TaskEnvelopeStore.create({
    taskId: 'fixture-1', batchId: 'b1', taskIndex: 0,
    route: 'delegate', agentType: 'standard',
    client: 'claude-code', mainModel: 'claude-opus-4-7', cwd: '/tmp',
    reviewPolicy: 'reviewed',
  });
  store.startStage('implementing', { model: 'claude-haiku-4-5', tier: 'standard', round: 1 });
  store.completeStage('implementing', 1, {
    outcome: 'advance', durationMs: 1000, costUSD: 0.01,
    inputTokens: 100, outputTokens: 50, cachedReadTokens: 0, cachedNonReadTokens: 0,
    turnsUsed: 2, filesWrittenCount: 1,
  });
  store.startStage('reviewing', { model: 'claude-haiku-4-5', tier: 'standard', round: 1 });
  store.completeStage('reviewing', 1, {
    outcome: 'advance', durationMs: 500, costUSD: 0.005, verdict: 'approved',
    inputTokens: 50, outputTokens: 25, cachedReadTokens: 0, cachedNonReadTokens: 0,
    turnsUsed: 1, filesWrittenCount: 0,
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

describe('wire-record blast radius', () => {
  it('an execution ending differently differs on the wire ONLY in its outcome fields', () => {
    // Same work, two endings. `buildEnvelope` records identical stages, tokens, costs and tool
    // calls for both; only the seal differs, and the wire projects terminalStatus/workerStatus
    // from it via mapStatusToWire.
    const pre = buildEnvelope({ status: 'failed', errorCode: 'sdk_execution_error' });
    const post = buildEnvelope({ status: 'done', errorCode: null });

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
