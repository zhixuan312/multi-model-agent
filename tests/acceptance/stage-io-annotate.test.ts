// tests/acceptance/stage-io-annotate.test.ts
//
// Covers AC-9, AC-10, AC-11, AC-12, AC-13, AC-23 from spec §11.
// Annotator parser / passthrough / invented-findings / transport-fallback /
// commit-message honesty / recovery-message specificity.

import { describe, it, expect } from 'vitest';
import { applyAnnotatePreconditions } from '../../packages/core/src/lifecycle/annotate-parser.js';
import { annotator } from '../../packages/core/src/lifecycle/handlers/annotate-stage.js';
import type { AnnotatePayload } from '../../packages/core/src/lifecycle/stage-io.js';
import type { LifecycleState } from '../../packages/core/src/lifecycle/stage-plan-types.js';
import { mockAnnotateState } from '../fixtures/lifecycle-state.js';

function mkPayload(over: Partial<AnnotatePayload> = {}): AnnotatePayload {
  return {
    completed: true,
    message: 'ok',
    findings: [],
    summary: '',
    filesChanged: [],
    commitSha: null,
    ...over,
  };
}
function mkState(over: Partial<LifecycleState> & Record<string, unknown> = {}): LifecycleState {
  return {
    terminal: false, reviewPolicy: 'full',
    shutdownInProgress: false, route: 'delegate',
    ...over,
  } as unknown as LifecycleState;
}

describe('AC-9: parser overrides completed=true to false on each precondition failure', () => {
  it('write route: review verdict=changes_required with no rework', () => {
    const state = mkState({
      route: 'delegate',
      reviewVerdict: 'changes_required',
      commits: [{ sha: 'a' }],
      gates: { implement: { outcome: 'advance' }, commit: { payload: { kind: 'committed' } } },
      lastRunResult: { workerStatus: 'done', status: 'ok' },
    });
    const out = applyAnnotatePreconditions(mkPayload({ completed: true }), state);
    expect(out.completed).toBe(false);
  });

  it('read route: zero criteria succeeded with errors', () => {
    const state = mkState({
      route: 'investigate',
      gates: { implement: { outcome: 'advance' } },
      lastRunResult: { workerStatus: 'done', status: 'ok', criteriaSucceeded: [], criteriaErrors: [{ criterionId: 'c', error: 'x' }] },
    });
    const out = applyAnnotatePreconditions(mkPayload({ completed: true }), state);
    expect(out.completed).toBe(false);
  });
});

describe('AC-11: passthrough — filesChanged and commitSha mechanically copy from upstream gates', () => {
  it('annotator overrides filesChanged from commit.payload regardless of LLM proposal', async () => {
    const state = mockAnnotateState({ route: 'delegate' });
    // Stash a commit payload with a specific file list.
    state.gates!['commit'] = {
      outcome: 'advance',
      payload: { kind: 'committed', commitSha: 'sha-A', commitMessage: 'm', filesChanged: ['only/this.ts'], authoredAt: 'now' } as any,
      telemetry: { stageLabel: 'commit', durationMs: 0, costUSD: 0, turnsUsed: 0, stopReason: 'normal' },
    } as any;
    (state as { lastRunResult?: any }).lastRunResult = { workerStatus: 'done', status: 'ok', filesChanged: ['llm-claimed.ts'] };
    const gate = await annotator(state);
    const p = gate.payload as AnnotatePayload;
    expect(p.filesChanged).toEqual(['only/this.ts']);
    expect(p.commitSha).toBe('sha-A');
  });
});

describe('AC-12: annotate never returns halt (transport-error → deterministic advance)', () => {
  it('annotator returns outcome=advance even when LLM transport fails', async () => {
    const state = mockAnnotateState({ llmAlwaysFails: true, route: 'delegate' });
    (state as { lastRunResult?: any }).lastRunResult = { workerStatus: 'done', status: 'ok' };
    const gate = await annotator(state);
    expect(gate.outcome).toBe('advance');
    expect(gate.payload).toBeDefined();
  });
});

describe('AC-23: completed=false message names specific blocking gate or finding', () => {
  // Spec §11 AC-23: When annotate emits completed:false, the message field
  // must name a specific blocking gate (e.g. "review halted: ...") OR a
  // specific finding ID (e.g. "unaddressed F3: ...") AND include a recovery
  // suggestion. Pattern-match test rejects generic strings like
  // "task failed" / "incomplete" / "error".
  const GENERIC_STRINGS = ['task failed', 'incomplete', 'error', 'unknown'];

  function assertSpecificAndRecoverable(message: string): void {
    // Message must be non-empty and longer than a generic one-liner.
    expect(message.length).toBeGreaterThan(20);
    // Must NOT be one of the prohibited generic strings (case-insensitive).
    const lower = message.toLowerCase().trim();
    for (const generic of GENERIC_STRINGS) {
      expect(lower).not.toBe(generic);
    }
    // Must mention either a stage name OR a finding ID OR an explicit cause.
    const hasGate = /(review|rework|commit|implement|annotate|criteria|worker)/i.test(message);
    const hasFinding = /F\d+/.test(message);
    const hasCause = /(verdict|self-?assessed|unaddressed|no commit|no_diff|hook|landed|succeeded|criteria)/i.test(message);
    expect(hasGate || hasFinding || hasCause).toBe(true);
    // Must include a recovery suggestion (re-dispatch / retry / investigate / etc.).
    expect(message).toMatch(/(re-?dispatch|retry|investigate|recommend|rework|fix|address)/i);
  }

  it('write route — review verdict=changes_required names review + recommends recovery', () => {
    const state = mkState({
      route: 'delegate',
      reviewVerdict: 'changes_required',
      commits: [{ sha: 'a' }],
      lastRunResult: { workerStatus: 'done', status: 'ok' },
    });
    const out = applyAnnotatePreconditions(mkPayload({ completed: true }), state);
    expect(out.completed).toBe(false);
    assertSpecificAndRecoverable(out.message);
    expect(out.message).toMatch(/review/i);
  });

  it('write route — unaddressed rework findings name the finding IDs verbatim', () => {
    const state = mkState({
      route: 'delegate',
      reviewVerdict: 'changes_required',
      reworkApplied: true,
      commits: [{ sha: 'a' }],
      lastRunResult: { workerStatus: 'done', status: 'ok', unaddressedFindingIds: ['F3', 'F7'] },
    });
    const out = applyAnnotatePreconditions(mkPayload({ completed: true }), state);
    expect(out.completed).toBe(false);
    assertSpecificAndRecoverable(out.message);
    expect(out.message).toMatch(/F3/);
    expect(out.message).toMatch(/F7/);
  });

  it('write route — no commit landed names the commit gate', () => {
    const state = mkState({
      route: 'delegate',
      reviewVerdict: 'approved',
      commits: [],
      lastRunResult: { workerStatus: 'done', status: 'ok' },
    });
    const out = applyAnnotatePreconditions(mkPayload({ completed: true }), state);
    expect(out.completed).toBe(false);
    assertSpecificAndRecoverable(out.message);
    expect(out.message).toMatch(/commit/i);
  });

  it('read route — zero criteria succeeded names the criteria gate', () => {
    const state = mkState({
      route: 'investigate',
      lastRunResult: {
        workerStatus: 'done', status: 'ok',
        criteriaSucceeded: [], criteriaErrors: [{ criterionId: 'c1', error: 'timeout' }],
      },
    });
    const out = applyAnnotatePreconditions(mkPayload({ completed: true }), state);
    expect(out.completed).toBe(false);
    assertSpecificAndRecoverable(out.message);
    expect(out.message).toMatch(/criteria/i);
  });

  it('worker self-assess "failed" does not block when objective signals agree (4.7.8)', () => {
    const result = applyAnnotatePreconditions(
      { completed: true, message: '', findings: [] } as never,
      {
        route: 'delegate',
        reviewPolicy: 'full',
        reworkApplied: false,
        gates: {
          implement: { outcome: 'advance' },
          review: { outcome: 'advance', payload: { verdict: 'approved', findings: [] } },
          commit: { payload: { kind: 'committed' } },
        },
        lastRunResult: { workerStatus: 'failed' } as never,
      } as never,
    );
    expect(result.completed).toBe(true);
    expect(result.message).not.toMatch(/worker self/i);
  });
});

// AC-13 (commit-message honesty for unaddressed findings) removed in goal mode:
// the MMA commit handler is gone — the agent self-commits per task, and the
// goal report surfaces unaddressed work via the `incomplete_plan` finding
// (see goal-report.ts + tests/lifecycle/goal-report.test.ts).
