// tests/lifecycle/deterministic-commit-route-coverage.test.ts
//
// Acceptance test proving deterministic commit-message composition across
// the three write routes (execute-plan, delegate, retry).
//
// Per spec Fix A: all three routes produce conventional-commit messages
// from task metadata, with execute-plan adding (Task N) trailers.
// Validates that commit composition is deterministic and grounded in actual diffs.

import { describe, it, expect } from 'vitest';
import { composeCommitMessage } from '../../packages/core/src/lifecycle/handlers/compose-commit-message.js';
import type { LifecycleState } from '../../packages/core/src/lifecycle/stage-plan-types.js';
import { mockState } from '../fixtures/lifecycle-state.js';

describe('AC-20: Deterministic commit-message composition across write routes', () => {
  describe('execute-plan route', () => {
    it('produces deterministic conventional-commit with (Task N) trailer', () => {
      // execute-plan: Task 3: add new parser handler → feat(lifecycle): add new parser handler (Task 3)
      const state = mockState({
        route: 'execute-plan',
        task: { taskDescriptor: 'Task 3: add new parser handler', prompt: '' },
      });
      const msg = composeCommitMessage(state, ['packages/core/src/lifecycle/handler.ts'], '/repo');
      expect(msg).toMatch(/^feat\(lifecycle\):/);
      expect(msg).toContain('add new parser handler');
      expect(msg).toContain('(Task 3)');
    });

    it('omits (Task N) trailer when heading lacks Task token', () => {
      const state = mockState({
        route: 'execute-plan',
        task: { taskDescriptor: 'add new feature', prompt: '' },
      });
      const msg = composeCommitMessage(state, ['packages/core/src/lifecycle/handler.ts'], '/repo');
      expect(msg).toMatch(/^feat\(lifecycle\):/);
      expect(msg).toContain('add new feature');
      expect(msg).not.toContain('(Task');
    });
  });

  describe('delegate route', () => {
    it('produces deterministic conventional-commit without (Task N) trailer', () => {
      // delegate: "implement the auth handler" → feat(lifecycle): implement the auth handler
      const state = mockState({
        route: 'delegate',
        task: { prompt: 'implement the auth handler' },
      });
      const msg = composeCommitMessage(state, ['packages/core/src/lifecycle/handler.ts'], '/repo');
      expect(msg).toMatch(/^feat\(lifecycle\):/);
      expect(msg).toContain('implement the auth handler');
      expect(msg).not.toContain('(Task');
    });

    it('infers fix type from fix/correct verb', () => {
      const state = mockState({
        route: 'delegate',
        task: { prompt: 'correct the parser boundary bug' },
      });
      const msg = composeCommitMessage(state, ['packages/core/src/lifecycle/handler.ts'], '/repo');
      expect(msg).toMatch(/^fix\(lifecycle\):/);
      expect(msg).toContain('correct the parser boundary bug');
    });
  });

  describe('retry route', () => {
    it('produces deterministic conventional-commit without (Task N) trailer', () => {
      // retry: "fix the regression" → fix(lifecycle): fix the regression
      const state = mockState({
        route: 'retry',
        task: { prompt: 'fix the regression' },
      });
      const msg = composeCommitMessage(state, ['packages/core/src/lifecycle/handler.ts'], '/repo');
      expect(msg).toMatch(/^fix\(lifecycle\):/);
      expect(msg).toContain('fix the regression');
      expect(msg).not.toContain('(Task');
    });

    it('uses first line of multi-line prompt', () => {
      const state = mockState({
        route: 'retry',
        task: { prompt: 'add resilience\nensure backoff\nmonitor cascades' },
      });
      const msg = composeCommitMessage(state, ['packages/core/src/lifecycle/handler.ts'], '/repo');
      expect(msg).toMatch(/^feat\(lifecycle\):/);
      expect(msg).toContain('add resilience');
      expect(msg).not.toContain('ensure backoff');
    });
  });

  describe('Determinism: identical inputs across routes', () => {
    it('execute-plan with same task always produces same message', () => {
      const state1 = mockState({
        route: 'execute-plan',
        task: { taskDescriptor: 'Task 1: add parser helper', prompt: '' },
      });
      const state2 = mockState({
        route: 'execute-plan',
        task: { taskDescriptor: 'Task 1: add parser helper', prompt: '' },
      });
      const files = ['packages/core/src/lifecycle/handler.ts'];
      const msg1 = composeCommitMessage(state1, files, '/repo');
      const msg2 = composeCommitMessage(state2, files, '/repo');
      expect(msg1).toBe(msg2);
    });

    it('delegate with same prompt always produces same message', () => {
      const state1 = mockState({
        route: 'delegate',
        task: { prompt: 'fix the boundary condition' },
      });
      const state2 = mockState({
        route: 'delegate',
        task: { prompt: 'fix the boundary condition' },
      });
      const files = ['packages/core/src/lifecycle/handler.ts'];
      const msg1 = composeCommitMessage(state1, files, '/repo');
      const msg2 = composeCommitMessage(state2, files, '/repo');
      expect(msg1).toBe(msg2);
    });

    it('retry with same prompt always produces same message', () => {
      const state1 = mockState({
        route: 'retry',
        task: { prompt: 'implement resilience' },
      });
      const state2 = mockState({
        route: 'retry',
        task: { prompt: 'implement resilience' },
      });
      const files = ['packages/core/src/lifecycle/handler.ts'];
      const msg1 = composeCommitMessage(state1, files, '/repo');
      const msg2 = composeCommitMessage(state2, files, '/repo');
      expect(msg1).toBe(msg2);
    });
  });

  describe('Message format compliance', () => {
    it('type is inferred: add/implement → feat', () => {
      const state = mockState({
        route: 'delegate',
        task: { prompt: 'add the missing utility' },
      });
      const msg = composeCommitMessage(state, ['packages/core/src/lifecycle/handler.ts'], '/repo');
      expect(msg).toMatch(/^feat/);
    });

    it('type is inferred: fix/correct → fix', () => {
      const state = mockState({
        route: 'delegate',
        task: { prompt: 'fix the parser edge case' },
      });
      const msg = composeCommitMessage(state, ['packages/core/src/lifecycle/handler.ts'], '/repo');
      expect(msg).toMatch(/^fix/);
    });

    it('type is inferred: remove/delete → chore', () => {
      const state = mockState({
        route: 'delegate',
        task: { prompt: 'remove the deprecated handler' },
      });
      const msg = composeCommitMessage(state, ['packages/core/src/lifecycle/handler.ts'], '/repo');
      expect(msg).toMatch(/^chore/);
    });

    it('scope is derived from most-common src/ segment', () => {
      const files = [
        'packages/core/src/lifecycle/a.ts',
        'packages/core/src/lifecycle/b.ts',
        'packages/core/src/config/c.ts',
      ];
      const state = mockState({
        route: 'delegate',
        task: { prompt: 'add features' },
      });
      const msg = composeCommitMessage(state, files, '/repo');
      expect(msg).toMatch(/^feat\(lifecycle\):/);
    });

    it('scope is omitted when top scopes are tied', () => {
      const files = [
        'packages/core/src/lifecycle/a.ts',
        'packages/core/src/config/b.ts',
      ];
      const state = mockState({
        route: 'delegate',
        task: { prompt: 'add features' },
      });
      const msg = composeCommitMessage(state, files, '/repo');
      expect(msg).toMatch(/^feat:/);
      expect(msg).not.toMatch(/^feat\(/);
    });

    it('subject line is limited to 72 chars', () => {
      const longSubject = 'a'.repeat(100);
      const state = mockState({
        route: 'delegate',
        task: { prompt: `add ${longSubject}` },
      });
      const msg = composeCommitMessage(state, ['packages/core/src/lifecycle/handler.ts'], '/repo');
      const firstLine = msg.split('\n')[0];
      expect(firstLine.length).toBeLessThanOrEqual(72);
    });
  });
});
