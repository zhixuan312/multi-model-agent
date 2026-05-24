import { describe, it, expect } from 'vitest';
import { enrichRuntimeResult } from '../../../packages/core/src/lifecycle/handlers/enrich-runtime-result.js';
import type { LifecycleState } from '../../../packages/core/src/lifecycle/stage-plan-types.js';
import type { RuntimeRunResult } from '../../../packages/core/src/types.js';
import type { CommitPayload } from '../../../packages/core/src/lifecycle/stage-io.js';

describe('enrichRuntimeResult — workerSelfAssessment reconciliation truth table', () => {
  function makeState(lastRunResult: Partial<RuntimeRunResult>): LifecycleState {
    return {
      cwd: '/test',
      route: 'delegate',
      assignmentId: 'test-id',
      executionContext: undefined,
      lastRunResult: { ...lastRunResult } as RuntimeRunResult,
      reviewPolicy: 'full',
    } as LifecycleState;
  }

  // Canonical objective signals (same sources as deriveCompletion):
  //   commit → state.gates.commit.payload.kind ; verdict → state.gates.review.payload.verdict
  const setGates = (state: any, commitKind?: 'committed' | 'no_op', verdict?: string) => {
    state.gates = {
      ...(commitKind ? { commit: { outcome: 'advance', payload: { kind: commitKind } } } : {}),
      ...(verdict ? { review: { outcome: 'advance', payload: { verdict, findings: [] } } } : {}),
    };
  };

  describe('parsedCleanly: false with commit gate + verdict', () => {
    it('false + committed + approved → done (with selfAssessmentReconciled)', () => {
      const state = makeState({
        workerStatus: 'failed',
        output: '```json\n{"summary":"test","workerSelfAssessment":"failed"}\n```',
      });
      (state.lastRunResult as any).parsedCleanly = false;
      setGates(state, 'committed', 'approved');

      enrichRuntimeResult(state);

      const enriched = state.lastRunResult as any;
      expect(enriched.workerStatus).toBe('done');
      expect(enriched.selfAssessmentReconciled).toBe(true);
    });

    it('false + committed + changes_required → failed (preserved)', () => {
      const state = makeState({
        workerStatus: 'failed',
        output: '```json\n{"summary":"test","workerSelfAssessment":"failed"}\n```',
      });
      (state.lastRunResult as any).parsedCleanly = false;
      setGates(state, 'committed', 'changes_required');

      enrichRuntimeResult(state);

      const enriched = state.lastRunResult as any;
      expect(enriched.workerStatus).toBe('failed');
    });

    it('false + no-commit → failed', () => {
      const state = makeState({
        workerStatus: 'failed',
        output: '```json\n{"summary":"test","workerSelfAssessment":"failed"}\n```',
      });
      (state.lastRunResult as any).parsedCleanly = false;
      setGates(state, 'no_op', 'approved');

      enrichRuntimeResult(state);

      const enriched = state.lastRunResult as any;
      expect(enriched.workerStatus).toBe('failed');
    });
  });

  describe('parsedCleanly: true → preserve parsed value', () => {
    it('parsedCleanly: true with done → stays done', () => {
      const state = makeState({
        workerStatus: 'done',
        output: '```json\n{"summary":"test","workerSelfAssessment":"done"}\n```',
      });
      (state.lastRunResult as any).parsedCleanly = true;
      setGates(state, 'committed', 'approved');

      enrichRuntimeResult(state);

      const enriched = state.lastRunResult as any;
      expect(enriched.workerStatus).toBe('done');
    });

    it('parsedCleanly: true with failed → stays failed', () => {
      const state = makeState({
        workerStatus: 'failed',
        output: '```json\n{"summary":"test","workerSelfAssessment":"failed"}\n```',
      });
      (state.lastRunResult as any).parsedCleanly = true;
      setGates(state, 'committed', 'approved');

      enrichRuntimeResult(state);

      const enriched = state.lastRunResult as any;
      expect(enriched.workerStatus).toBe('failed');
    });
  });

  describe('missing-signal guard → preserve parsed value', () => {
    it('no commit gate → preserve parsed value', () => {
      const state = makeState({
        workerStatus: 'failed',
        output: '```json\n{"summary":"test","workerSelfAssessment":"failed"}\n```',
      });
      (state.lastRunResult as any).parsedCleanly = false;
      setGates(state, undefined, 'approved'); // verdict present, commit gate absent

      enrichRuntimeResult(state);

      const enriched = state.lastRunResult as any;
      expect(enriched.workerStatus).toBe('failed');
    });

    it('no verdict → preserve parsed value', () => {
      const state = makeState({
        workerStatus: 'failed',
        output: '```json\n{"summary":"test","workerSelfAssessment":"failed"}\n```',
      });
      (state.lastRunResult as any).parsedCleanly = false;
      setGates(state, 'committed', undefined); // commit present, verdict absent

      enrichRuntimeResult(state);

      const enriched = state.lastRunResult as any;
      expect(enriched.workerStatus).toBe('failed');
    });
  });
});
