import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { LifecycleState } from '../../../packages/core/src/lifecycle/stage-plan-types.js';

vi.mock('../../../packages/core/src/escalation/delegate-with-escalation.js', () => ({
  delegateWithEscalation: vi.fn(),
}));
import { delegateWithEscalation } from '../../../packages/core/src/escalation/delegate-with-escalation.js';
import {
  annotateCompletionHandler,
  computeCommitGatePercent,
  runVerifyCommand,
} from '../../../packages/core/src/lifecycle/handlers/annotate-completion-handler.js';

beforeEach(() => {
  vi.mocked(delegateWithEscalation).mockReset();
});

function baseState(verifyCommand?: string[]): LifecycleState {
  return {
    task: { prompt: 'do work', cwd: '/tmp', agentType: 'standard', verifyCommand },
    lastRunResult: {
      output: 'after reviews',
      status: 'ok',
      filesWritten: ['x.ts'],
      filesRead: [],
      toolCalls: [],
    },
    diffTracker: { cumulativeDiff: async () => '@@ +x' },
    executionContext: {
      cwd: '/tmp',
      assignedTier: 'standard',
      providers: {
        standard: { name: 'standard', config: { model: 'mock-s' } },
        complex: { name: 'complex', config: { model: 'mock-c' } },
      },
      timing: { timeoutMs: 30_000, deadlineMs: Date.now() + 30_000 },
      stall: { controller: new AbortController() },
    },
    reviewPolicy: 'full',
    specReviewerNotes: 'spec ok',
    qualityReviewerNotes: 'quality ok',
  } as unknown as LifecycleState;
}

function mockAnnotatorReturns(json: string): void {
  vi.mocked(delegateWithEscalation).mockResolvedValueOnce({
    output: '```json\n' + json + '\n```',
    status: 'ok',
    filesWritten: [],
    filesRead: [],
    toolCalls: [],
    escalationLog: [],
  } as unknown as never);
}

describe('runVerifyCommand', () => {
  it('returns ran=false when no command supplied', () => {
    const r = runVerifyCommand('/tmp', undefined);
    expect(r.ran).toBe(false);
    expect(r.passed).toBe(null);
    expect(r.command).toEqual([]);
  });

  it('returns passed=true on successful exec', () => {
    const r = runVerifyCommand('/tmp', ['echo', 'hello']);
    expect(r.ran).toBe(true);
    expect(r.passed).toBe(true);
    expect(r.exitCode).toBe(0);
    expect(r.tailOutput).toMatch(/hello/);
  });

  it('returns passed=false on non-zero exit', () => {
    const r = runVerifyCommand('/tmp', ['sh', '-c', 'exit 7']);
    expect(r.ran).toBe(true);
    expect(r.passed).toBe(false);
    expect(r.exitCode).toBe(7);
  });

  it('returns passed=false on missing command', () => {
    const r = runVerifyCommand('/tmp', ['/nonexistent/binary-9999']);
    expect(r.ran).toBe(true);
    expect(r.passed).toBe(false);
  });
});

describe('computeCommitGatePercent', () => {
  it('full backstop when files + verify-passed + no missing steps', () => {
    const v = computeCommitGatePercent(95, true, 2, true, [
      { status: 'done' }, { status: 'partial' },
    ]);
    expect(v).toBe(95);  // backstop=100, min with 95 → 95
  });

  it('backstop is additive; row 5.2 gate enforces filesWritten>0 separately (§2.5)', () => {
    // files=0 + verify=true + no-missing → backstop = 0 + 30 + 20 = 50; min(50, 100) = 50.
    // The 50 is a non-issue because row 5.2's runCondition rejects when filesWritten.length === 0.
    const v = computeCommitGatePercent(100, true, 0, true, [{ status: 'done' }]);
    expect(v).toBe(50);
  });

  it('partial backstop when no missing step but parse failed', () => {
    const v = computeCommitGatePercent(50, false, 2, true, [{ status: 'done' }]);
    expect(v).toBe(50);  // backstop = 50 + 30 + 0 (parseSucceeded false) = 80; min(80, 50) = 50
  });

  it('caps at annotator percent', () => {
    const v = computeCommitGatePercent(40, true, 2, true, [{ status: 'done' }]);
    expect(v).toBe(40);  // backstop = 100, min with 40 = 40
  });

  it('zero when annotator says 0 (fallback case)', () => {
    const v = computeCommitGatePercent(0, false, 2, true, []);
    expect(v).toBe(0);
  });
});

describe('annotateCompletionHandler', () => {
  it('skips when reviewPolicy is "none"', async () => {
    const state = baseState();
    state.reviewPolicy = 'none';
    await annotateCompletionHandler(state);
    expect(state.completionAnnotation).toBeUndefined();
    expect(state.commitGatePercent).toBeUndefined();
  });

  it('on valid annotator output: stores annotation + commitGatePercent', async () => {
    mockAnnotatorReturns(JSON.stringify({
      completionPercent: 90,
      perStep: [
        { step: 'S1', status: 'done', note: null },
        { step: 'S2', status: 'done', note: null },
      ],
      concerns: [],
    }));
    const state = baseState(['echo', 'PASS']);
    await annotateCompletionHandler(state);
    expect(state.completionAnnotation?.completionPercent).toBe(90);
    expect(state.completionAnnotation?.perStep).toHaveLength(2);
    expect(state.completionAnnotation?.verify.passed).toBe(true);  // overlay from runVerifyCommand
    expect(state.commitGatePercent).toBe(90);  // min(100, 90)
    expect(state.completionAnnotationError).toBeUndefined();
  });

  it('on malformed annotator: retries once, falls back to 0 on second failure', async () => {
    vi.mocked(delegateWithEscalation).mockResolvedValue({
      output: 'no JSON here',
      status: 'ok',
      filesWritten: [], filesRead: [], toolCalls: [], escalationLog: [],
    } as unknown as never);
    const state = baseState();
    await annotateCompletionHandler(state);
    expect(vi.mocked(delegateWithEscalation)).toHaveBeenCalledTimes(2);  // initial + retry
    expect(state.completionAnnotationError).toMatch(/no.*fenced block/);
    expect(state.completionAnnotation?.completionPercent).toBe(0);
    expect(state.commitGatePercent).toBe(0);
  });

  it('on provider error: fallback annotation + commitGatePercent=0', async () => {
    vi.mocked(delegateWithEscalation).mockRejectedValueOnce(new Error('annotator boom'));
    const state = baseState();
    await annotateCompletionHandler(state);
    expect(state.completionAnnotationError).toMatch(/annotator boom/);
    expect(state.commitGatePercent).toBe(0);
  });

  it('captures verify command output in state.verifyResult', async () => {
    mockAnnotatorReturns(JSON.stringify({ completionPercent: 50, perStep: [], concerns: [] }));
    const state = baseState(['echo', 'verifying']);
    await annotateCompletionHandler(state);
    expect(state.verifyResult).toBeDefined();
    const verify = state.verifyResult as { ran: boolean; passed: boolean; tailOutput: string };
    expect(verify.ran).toBe(true);
    expect(verify.passed).toBe(true);
    expect(verify.tailOutput).toMatch(/verifying/);
  });

  it('handles missing verify command (ran=false)', async () => {
    mockAnnotatorReturns(JSON.stringify({ completionPercent: 50, perStep: [], concerns: [] }));
    const state = baseState();  // no verifyCommand
    await annotateCompletionHandler(state);
    expect(state.verifyResult).toBeDefined();
    expect((state.verifyResult as { ran: boolean }).ran).toBe(false);
  });
});
