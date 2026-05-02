import {
  __forceClarification,
  __forceClarificationGlobal,
  __clearForcedClarification,
  __consumeForcedClarification,
} from '../../packages/core/src/intake/force-clarification.js';
import { runIntakePipeline } from '../../packages/core/src/intake/pipeline.js';
import type { DraftTask, MultiModelConfig } from '../../packages/core/src/index.js';

function makeConfig(): MultiModelConfig {
  return {
    defaults: {
      agentType: 'claude',
      maxTurns: 10,
      timeoutMs: 60_000,
    },
    providers: {
      claude: { apiKey: 'test-key', model: 'claude-sonnet-4-6' },
    },
  };
}

function makeDraft(overrides?: Partial<DraftTask>): DraftTask {
  return {
    draftId: `draft-${Math.random().toString(36).slice(2, 8)}`,
    source: { route: 'delegate_tasks', originalInput: {} },
    prompt: 'Add logging to the authentication module',
    done: 'Logging is added and tests pass',
    filePaths: ['src/auth.ts'],
    ...overrides,
  };
}

describe('__forceClarification test seam', () => {
  beforeEach(() => __clearForcedClarification());
  afterEach(() => __clearForcedClarification());

  describe('gating', () => {
    it('is no-op when NODE_ENV !== test', () => {
      const original = process.env.NODE_ENV;
      const originalSeams = process.env.MMAGENT_TEST_SEAMS;
      process.env.NODE_ENV = 'production';
      process.env.MMAGENT_TEST_SEAMS = '1';
      try {
        const batchId = __forceClarification('should not fire');
        expect(batchId).toBe('');
        const result = runIntakePipeline([makeDraft()], makeConfig(), undefined, batchId);
        expect(result.clarifications).toHaveLength(0);
      } finally {
        process.env.NODE_ENV = original;
        process.env.MMAGENT_TEST_SEAMS = originalSeams;
      }
    });

    it('is no-op when MMAGENT_TEST_SEAMS != 1', () => {
      const original = process.env.NODE_ENV;
      const originalSeams = process.env.MMAGENT_TEST_SEAMS;
      process.env.NODE_ENV = 'test';
      delete process.env.MMAGENT_TEST_SEAMS;
      try {
        const batchId = __forceClarification('should not fire');
        expect(batchId).toBe('');
        const result = runIntakePipeline([makeDraft()], makeConfig(), undefined, batchId);
        expect(result.clarifications).toHaveLength(0);
      } finally {
        process.env.NODE_ENV = original;
        process.env.MMAGENT_TEST_SEAMS = originalSeams;
      }
    });
  });

  describe('with seams enabled', () => {
    let originalNodeEnv: string | undefined;
    let originalSeams: string | undefined;

    beforeEach(() => {
      originalNodeEnv = process.env.NODE_ENV;
      originalSeams = process.env.MMAGENT_TEST_SEAMS;
      process.env.NODE_ENV = 'test';
      process.env.MMAGENT_TEST_SEAMS = '1';
    });

    afterEach(() => {
      process.env.NODE_ENV = originalNodeEnv;
      process.env.MMAGENT_TEST_SEAMS = originalSeams;
    });

    it('forces a clarification on the pipeline via batchId', () => {
      const batchId = __forceClarification('test reason');
      expect(batchId).toBeTruthy();

      const result = runIntakePipeline([makeDraft()], makeConfig(), undefined, batchId);
      expect(result.clarifications).toHaveLength(1);
      expect(result.clarifications[0].questions[0]).toContain('test reason');
      expect(result.ready).toHaveLength(0);
    });

    it('generates auto batchId when none provided', () => {
      const batchId = __forceClarification('auto id reason');
      expect(batchId).toMatch(/^forced-/);

      const result = runIntakePipeline([makeDraft()], makeConfig(), undefined, batchId);
      expect(result.clarifications).toHaveLength(1);
    });

    it('clears forced clarification by batchId', () => {
      const batchId = __forceClarification('reason');
      __clearForcedClarification(batchId);

      const result = runIntakePipeline([makeDraft()], makeConfig(), undefined, batchId);
      expect(result.clarifications).toHaveLength(0);
    });

    it('clears all forced clarifications with no-arg clear', () => {
      const batchId = __forceClarification('reason');
      __clearForcedClarification();

      const result = runIntakePipeline([makeDraft()], makeConfig(), undefined, batchId);
      expect(result.clarifications).toHaveLength(0);
    });

    it('is one-shot — consumed on first pipeline call', () => {
      const batchId = __forceClarification('one-shot reason');

      const first = runIntakePipeline([makeDraft()], makeConfig(), undefined, batchId);
      expect(first.clarifications).toHaveLength(1);

      const second = runIntakePipeline([makeDraft()], makeConfig(), undefined, batchId);
      expect(second.clarifications).toHaveLength(0);
    });

    it('handles multiple drafts in a single batch', () => {
      const batchId = __forceClarification('multi-draft reason');
      const drafts = [makeDraft(), makeDraft(), makeDraft()];

      const result = runIntakePipeline(drafts, makeConfig(), undefined, batchId);
      expect(result.clarifications).toHaveLength(3);
      expect(result.clarifications[0].questions[0]).toContain('multi-draft reason');
      expect(result.clarifications[1].questions[0]).toContain('multi-draft reason');
      expect(result.clarifications[2].questions[0]).toContain('multi-draft reason');
    });
  });

  describe('__forceClarificationGlobal', () => {
    let originalNodeEnv: string | undefined;
    let originalSeams: string | undefined;

    beforeEach(() => {
      originalNodeEnv = process.env.NODE_ENV;
      originalSeams = process.env.MMAGENT_TEST_SEAMS;
      process.env.NODE_ENV = 'test';
      process.env.MMAGENT_TEST_SEAMS = '1';
    });

    afterEach(() => {
      process.env.NODE_ENV = originalNodeEnv;
      process.env.MMAGENT_TEST_SEAMS = originalSeams;
    });

    it('forces clarification on any batchId when global is set', () => {
      __forceClarificationGlobal('global reason');

      const result = runIntakePipeline([makeDraft()], makeConfig(), undefined, 'any-batch-id');
      expect(result.clarifications).toHaveLength(1);
      expect(result.clarifications[0].questions[0]).toContain('global reason');
    });

    it('is one-shot — consumed on first pipeline call', () => {
      __forceClarificationGlobal('global one-shot');

      const first = runIntakePipeline([makeDraft()], makeConfig(), undefined, 'batch-1');
      expect(first.clarifications).toHaveLength(1);

      const second = runIntakePipeline([makeDraft()], makeConfig(), undefined, 'batch-2');
      expect(second.clarifications).toHaveLength(0);
    });

    it('cleared by __clearForcedClarification', () => {
      __forceClarificationGlobal('global reason');
      __clearForcedClarification();

      const result = runIntakePipeline([makeDraft()], makeConfig(), undefined, 'any-batch-id');
      expect(result.clarifications).toHaveLength(0);
    });

    it('specific batchId takes precedence over global', () => {
      __forceClarificationGlobal('global reason');
      const specificId = __forceClarification('specific reason');

      const result = runIntakePipeline([makeDraft()], makeConfig(), undefined, specificId);
      expect(result.clarifications).toHaveLength(1);
      expect(result.clarifications[0].questions[0]).toContain('specific reason');
    });
  });

  describe('__consumeForcedClarification', () => {
    it('returns null when seams are disabled', () => {
      const result = __consumeForcedClarification('any-id');
      expect(result).toBeNull();
    });

    it('returns null for unknown batchId with seams enabled', () => {
      const originalNodeEnv = process.env.NODE_ENV;
      const originalSeams = process.env.MMAGENT_TEST_SEAMS;
      process.env.NODE_ENV = 'test';
      process.env.MMAGENT_TEST_SEAMS = '1';
      try {
        const result = __consumeForcedClarification('unknown-id');
        expect(result).toBeNull();
      } finally {
        process.env.NODE_ENV = originalNodeEnv;
        process.env.MMAGENT_TEST_SEAMS = originalSeams;
      }
    });

    it('reads from MMAGENT_FORCED_CLARIFICATION env var', () => {
      const originalNodeEnv = process.env.NODE_ENV;
      const originalSeams = process.env.MMAGENT_TEST_SEAMS;
      process.env.NODE_ENV = 'test';
      process.env.MMAGENT_TEST_SEAMS = '1';
      process.env.MMAGENT_FORCED_CLARIFICATION = 'env reason';
      try {
        const result = __consumeForcedClarification('any-id');
        expect(result).toBe('env reason');
      } finally {
        process.env.NODE_ENV = originalNodeEnv;
        process.env.MMAGENT_TEST_SEAMS = originalSeams;
        delete process.env.MMAGENT_FORCED_CLARIFICATION;
      }
    });
  });

  describe('pipeline without batchId does not check seam', () => {
    it('passes through normally when no batchId is provided', () => {
      const originalNodeEnv = process.env.NODE_ENV;
      const originalSeams = process.env.MMAGENT_TEST_SEAMS;
      process.env.NODE_ENV = 'test';
      process.env.MMAGENT_TEST_SEAMS = '1';
      try {
        __forceClarification('should not matter');
        const result = runIntakePipeline([makeDraft()], makeConfig());
        // Normal classification — a well-formed draft should be ready
        expect(result.ready.length + result.clarifications.length).toBeGreaterThan(0);
        // The forced clarification should NOT have been consumed
        expect(result.clarifications).toHaveLength(0);
      } finally {
        process.env.NODE_ENV = originalNodeEnv;
        process.env.MMAGENT_TEST_SEAMS = originalSeams;
      }
    });
  });
});
