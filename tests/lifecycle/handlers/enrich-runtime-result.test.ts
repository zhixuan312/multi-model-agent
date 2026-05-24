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
    } as LifecycleState;
  }

  describe('parsedCleanly: false with commit gate + verdict', () => {
    it('false + committed + approved → done (with selfAssessmentReconciled)', () => {
      const state = makeState({
        parsedCleanly: false,
        workerStatus: 'failed',
        output: '```json\n{"summary":"test","workerSelfAssessment":"failed"}\n```',
      });
      state.commits = [{
        kind: 'committed',
        commitSha: 'abc123',
        commitMessage: 'test commit',
        filesChanged: [],
        authoredAt: '2024-01-01T00:00:00Z',
      } as CommitPayload];
      state.reviewPolicy = 'full';
      state.diffReviewVerdict = 'approved';

      enrichRuntimeResult(state);

      const enriched = state.lastRunResult as any;
      expect(enriched.workerStatus).toBe('done');
      expect(enriched.selfAssessmentReconciled).toBe(true);
    });

    it('false + committed + changes_required → failed (preserved)', () => {
      const state = makeState({
        parsedCleanly: false,
        workerStatus: 'failed',
        output: '```json\n{"summary":"test","workerSelfAssessment":"failed"}\n```',
      });
      state.commits = [{
        kind: 'committed',
        commitSha: 'abc123',
        commitMessage: 'test commit',
        filesChanged: [],
        authoredAt: '2024-01-01T00:00:00Z',
      } as CommitPayload];
      state.reviewPolicy = 'full';
      state.diffReviewVerdict = 'changes_required';

      enrichRuntimeResult(state);

      const enriched = state.lastRunResult as any;
      expect(enriched.workerStatus).toBe('failed');
    });

    it('false + no-commit → failed', () => {
      const state = makeState({
        parsedCleanly: false,
        workerStatus: 'failed',
        output: '```json\n{"summary":"test","workerSelfAssessment":"failed"}\n```',
      });
      state.commits = [{
        kind: 'no_op',
        reason: 'no_diff',
      } as CommitPayload];
      state.reviewPolicy = 'none';

      enrichRuntimeResult(state);

      const enriched = state.lastRunResult as any;
      expect(enriched.workerStatus).toBe('failed');
    });
  });

  describe('parsedCleanly: true → preserve parsed value', () => {
    it('parsedCleanly: true with done → stays done', () => {
      const state = makeState({
        parsedCleanly: true,
        workerStatus: 'done',
        output: '```json\n{"summary":"test","workerSelfAssessment":"done"}\n```',
      });
      state.commits = [];

      enrichRuntimeResult(state);

      const enriched = state.lastRunResult as any;
      expect(enriched.workerStatus).toBe('done');
    });

    it('parsedCleanly: true with failed → stays failed', () => {
      const state = makeState({
        parsedCleanly: true,
        workerStatus: 'failed',
        output: '```json\n{"summary":"test","workerSelfAssessment":"failed"}\n```',
      });
      state.commits = [];

      enrichRuntimeResult(state);

      const enriched = state.lastRunResult as any;
      expect(enriched.workerStatus).toBe('failed');
    });
  });

  describe('missing-signal guard → preserve parsed value', () => {
    it('no commit gate → preserve parsed value', () => {
      const state = makeState({
        parsedCleanly: false,
        workerStatus: 'failed',
        output: '```json\n{"summary":"test","workerSelfAssessment":"failed"}\n```',
      });
      state.commits = undefined;
      state.reviewPolicy = 'none';

      enrichRuntimeResult(state);

      const enriched = state.lastRunResult as any;
      expect(enriched.workerStatus).toBe('failed');
    });

    it('no verdict → preserve parsed value', () => {
      const state = makeState({
        parsedCleanly: false,
        workerStatus: 'failed',
        output: '```json\n{"summary":"test","workerSelfAssessment":"failed"}\n```',
      });
      state.commits = [{
        kind: 'committed',
        commitSha: 'abc123',
        commitMessage: 'test commit',
        filesChanged: [],
        authoredAt: '2024-01-01T00:00:00Z',
      } as CommitPayload];
      state.reviewPolicy = 'none';
      state.diffReviewVerdict = undefined;

      enrichRuntimeResult(state);

      const enriched = state.lastRunResult as any;
      expect(enriched.workerStatus).toBe('failed');
    });
  });
});
