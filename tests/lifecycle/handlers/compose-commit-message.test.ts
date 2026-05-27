import { describe, it, expect } from 'bun:test';
import { composeCommitMessage } from '../../../packages/core/src/lifecycle/handlers/compose-commit-message.js';
import type { LifecycleState } from '../../../packages/core/src/lifecycle/stage-plan-types.js';

function makeState(overrides: Partial<LifecycleState> = {}): LifecycleState {
  return {
    terminal: false,
    shutdownInProgress: false,
    reviewPolicy: 'none',
    ...overrides,
  };
}

describe('composeCommitMessage', () => {
  // ── taskDescriptor is the subject source for NON-execute-plan routes too ──
  // Regression: delegate/retry/journal-record TaskSpec.prompt is a COMPILED
  // prompt that leads with orientation boilerplate. The subject must come from
  // taskDescriptor (raw task intent), not the orientation line.

  it('delegate: subject derives from taskDescriptor, not the orientation-led prompt', () => {
    const state = makeState({
      route: 'delegate',
      task: {
        taskDescriptor: 'Create file src/a.ts with exactly: export const A=1',
        prompt: 'Your job: produce the SMALLEST COMPLETE CHANGE that satisfies the brief.\n\nBrief from the caller:\n\nCreate file src/a.ts ...',
      },
    });
    const msg = composeCommitMessage(state, ['packages/core/src/a.ts'], '/repo');
    expect(msg.split('\n')[0].toLowerCase()).toContain('create file src/a.ts');
    expect(msg.toLowerCase()).not.toContain('your job');
    expect(msg).not.toContain('(Task'); // no Task-N trailer off execute-plan
  });

  it('journal-record: subject derives from the learning, not the journal orientation', () => {
    const state = makeState({
      route: 'journal-record',
      task: {
        taskDescriptor: 'record learning: divide() lacks a zero-divisor guard; add an explicit throw',
        prompt: "You maintain a project's learnings journal at `.mmagent/journal/`. Integrate ONE new learning ...",
      },
    });
    const msg = composeCommitMessage(state, ['packages/core/src/journal/x.ts'], '/repo');
    expect(msg.toLowerCase()).toContain('record learning');
    expect(msg.toLowerCase()).not.toContain('you maintain');
  });

  // ── Type inference from leading verb ──────────────────────────────────────

  it('infers type "feat" from add/implement/create verbs', () => {
    const state = makeState({
      route: 'execute-plan',
      task: { taskDescriptor: 'Task 1: add new utility function', prompt: 'implement this' },
    });
    const msg = composeCommitMessage(state, ['packages/core/src/utils/helper.ts'], '/repo');
    expect(msg).toMatch(/^feat\(/);
  });

  it('infers type "fix" from fix/correct/repair verbs', () => {
    const state = makeState({
      route: 'execute-plan',
      task: { taskDescriptor: 'Task 2: fix parser boundary condition', prompt: 'correct this' },
    });
    const msg = composeCommitMessage(state, ['packages/core/src/parser.ts'], '/repo');
    expect(msg).toMatch(/^fix\(/);
  });

  it('infers type "chore" from remove/delete/drop verbs', () => {
    const state = makeState({
      route: 'execute-plan',
      task: { taskDescriptor: 'Task 3: remove deprecated API', prompt: 'delete old code' },
    });
    const msg = composeCommitMessage(state, ['packages/core/src/deprecated.ts'], '/repo');
    expect(msg).toMatch(/^chore\(/);
  });

  it('defaults to "feat" for other verbs', () => {
    const state = makeState({
      route: 'execute-plan',
      task: { taskDescriptor: 'Task 4: refactor the build system', prompt: 'improve this' },
    });
    const msg = composeCommitMessage(state, ['packages/core/src/build.ts'], '/repo');
    expect(msg).toMatch(/^feat\(/);
  });

  // ── Scope derivation from filesChanged ────────────────────────────────────

  it('extracts scope from single matching file (first segment after src/)', () => {
    const state = makeState({
      route: 'execute-plan',
      task: { taskDescriptor: 'Task 1: add helper', prompt: '' },
    });
    const msg = composeCommitMessage(state, ['/repo/packages/core/src/lifecycle/handlers/foo.ts'], '/repo');
    expect(msg).toMatch(/^feat\(lifecycle\):/);
  });

  it('picks most common scope across multiple files in same directory', () => {
    const state = makeState({
      route: 'execute-plan',
      task: { taskDescriptor: 'Task 1: add features', prompt: '' },
    });
    const msg = composeCommitMessage(state, [
      '/repo/packages/core/src/lifecycle/a.ts',
      '/repo/packages/core/src/lifecycle/b.ts',
      '/repo/packages/core/src/config/c.ts',
    ], '/repo');
    // lifecycle appears 2x, config 1x → scope should be lifecycle
    expect(msg).toMatch(/^feat\(lifecycle\):/);
  });

  it('omits scope when top scopes are tied', () => {
    const state = makeState({
      route: 'execute-plan',
      task: { taskDescriptor: 'Task 1: add features', prompt: '' },
    });
    const msg = composeCommitMessage(state, [
      '/repo/packages/core/src/lifecycle/a.ts',
      '/repo/packages/core/src/config/b.ts',
    ], '/repo');
    // tied 1-1 → omit scope
    expect(msg).toMatch(/^feat:/);
    expect(msg).not.toMatch(/^feat\(/);
  });

  it('omits scope when no matching paths exist', () => {
    const state = makeState({
      route: 'execute-plan',
      task: { taskDescriptor: 'Task 1: add stuff', prompt: '' },
    });
    const msg = composeCommitMessage(state, [
      '/repo/README.md',
      '/repo/package.json',
    ], '/repo');
    expect(msg).toMatch(/^feat:/);
    expect(msg).not.toMatch(/^feat\(/);
  });

  it('ignores non-matching paths and derives scope only from */src/* matches', () => {
    const state = makeState({
      route: 'execute-plan',
      task: { taskDescriptor: 'Task 1: add thing', prompt: '' },
    });
    const msg = composeCommitMessage(state, [
      '/repo/README.md',
      '/repo/packages/core/src/lifecycle/handler.ts',
      '/repo/package.json',
    ], '/repo');
    expect(msg).toMatch(/^feat\(lifecycle\):/);
  });

  // ── Subject text: heading parse and stripping ────────────────────────────

  it('strips leading "Task N:" from heading', () => {
    const state = makeState({
      route: 'execute-plan',
      task: { taskDescriptor: 'Task 5: add parser optimization', prompt: '' },
    });
    const msg = composeCommitMessage(state, ['packages/core/src/parser/opt.ts'], '/repo');
    expect(msg).toContain('add parser optimization');
    // The leading "Task 5:" prefix is stripped from the SUBJECT...
    expect(msg).not.toContain('Task 5:');
    expect(msg.split('\n')[0]).not.toMatch(/^[a-z]+(\([^)]+\))?: Task 5/);
    // ...but the intentional "(Task N)" trailer is present (spec Fix A table).
    expect(msg).toContain('(Task 5)');
  });

  it('strips leading ## markdown heading marker', () => {
    const state = makeState({
      route: 'execute-plan',
      task: { taskDescriptor: '## add critical feature', prompt: '' },
    });
    const msg = composeCommitMessage(state, ['packages/core/src/feature/main.ts'], '/repo');
    expect(msg).toContain('add critical feature');
  });

  it('strips leading # and ## and Task N: in any order', () => {
    const state = makeState({
      route: 'execute-plan',
      task: { taskDescriptor: '# Task 99: add stuff', prompt: '' },
    });
    const msg = composeCommitMessage(state, ['packages/core/src/module/a.ts'], '/repo');
    expect(msg).toContain('add stuff');
  });

  it('lowercases first letter of subject', () => {
    const state = makeState({
      route: 'execute-plan',
      task: { taskDescriptor: 'Task 1: Add This Feature', prompt: '' },
    });
    const msg = composeCommitMessage(state, ['packages/core/src/mod/x.ts'], '/repo');
    expect(msg).toMatch(/feat\(mod\): add/);
  });

  it('trims subject to 72 chars total (type+scope+subject)', () => {
    const longSubject = 'a'.repeat(100);
    const state = makeState({
      route: 'execute-plan',
      task: { taskDescriptor: `Task 1: add ${longSubject}`, prompt: '' },
    });
    const msg = composeCommitMessage(state, ['packages/core/src/xyz/f.ts'], '/repo');
    const firstLine = msg.split('\n')[0];
    expect(firstLine.length).toBeLessThanOrEqual(72);
  });

  // ── Subject resolution order (blank/missing headings, fallbacks) ─────────

  it('uses fallback when execute-plan heading is blank', () => {
    const state = makeState({
      route: 'execute-plan',
      task: { taskDescriptor: '', prompt: 'implement the feature\nmore details' },
    });
    const msg = composeCommitMessage(state, ['packages/core/src/mod/x.ts'], '/repo');
    expect(msg).toContain('implement the feature');
  });

  it('uses first line of delegate/retry prompt when no taskDescriptor', () => {
    const state = makeState({
      route: 'delegate',
      task: { prompt: 'fix the broken tests\nmake sure it works' },
    });
    const msg = composeCommitMessage(state, ['packages/core/src/tests/a.ts'], '/repo');
    expect(msg).toContain('fix the broken tests');
  });

  it('skips empty quote-lines and uses first subsequent usable line', () => {
    const state = makeState({
      route: 'delegate',
      task: { prompt: '>\nadd the handler' },
    });
    const msg = composeCommitMessage(state, ['packages/core/src/mod/x.ts'], '/repo');
    expect(msg).toContain('add the handler');
  });

  it('emits "feat: update requested files" when no usable subject line found', () => {
    const state = makeState({
      route: 'delegate',
      task: { prompt: '   \n\n   \n' }, // only whitespace
    });
    const msg = composeCommitMessage(state, ['packages/core/src/mod/x.ts'], '/repo');
    expect(msg).toBe('feat: update requested files');
  });

  it('does not emit empty or whitespace-only subject', () => {
    const state = makeState({
      route: 'execute-plan',
      task: { taskDescriptor: '   ', prompt: '' },
    });
    const msg = composeCommitMessage(state, ['packages/core/src/mod/x.ts'], '/repo');
    expect(msg).not.toMatch(/^\s*$/);
    expect(msg).toBeTruthy();
  });

  // ── (Task N) trailer ─────────────────────────────────────────────────────

  it('includes (Task N) trailer in execute-plan when heading contains Task token', () => {
    const state = makeState({
      route: 'execute-plan',
      task: { taskDescriptor: 'Task 3: add buildCancelledResult helper', prompt: '' },
    });
    const msg = composeCommitMessage(state, ['packages/core/src/lifecycle/a.ts'], '/repo');
    expect(msg).toContain('(Task 3)');
  });

  it('omits (Task N) trailer in execute-plan when heading has no Task token', () => {
    const state = makeState({
      route: 'execute-plan',
      task: { taskDescriptor: 'add some feature', prompt: '' },
    });
    const msg = composeCommitMessage(state, ['packages/core/src/lifecycle/a.ts'], '/repo');
    expect(msg).not.toContain('(Task');
  });

  it('omits (Task N) trailer in delegate route even if heading has Task', () => {
    const state = makeState({
      route: 'delegate',
      task: { prompt: 'Task 3: fix the bug' },
    });
    const msg = composeCommitMessage(state, ['packages/core/src/x/a.ts'], '/repo');
    expect(msg).not.toContain('(Task');
  });

  it('omits (Task N) trailer in retry route', () => {
    const state = makeState({
      route: 'retry',
      task: { prompt: 'Task 5: implement feature' },
    });
    const msg = composeCommitMessage(state, ['packages/core/src/x/a.ts'], '/repo');
    expect(msg).not.toContain('(Task');
  });

  // ── Body: included only when summaryTrustworthy ───────────────────────────

  it('includes body from implement payload when summaryTrustworthy is true', () => {
    const state = makeState({
      route: 'delegate',
      task: { prompt: 'add feature' },
      gates: {
        implement: {
          outcome: 'advance',
          payload: {
            summary: 'This is my summary\nwith details',
            summaryTrustworthy: true,
          },
        },
      },
    });
    const msg = composeCommitMessage(state, ['packages/core/src/x/a.ts'], '/repo');
    expect(msg).toContain('This is my summary');
  });

  it('omits body from implement payload when summaryTrustworthy is false', () => {
    const state = makeState({
      route: 'delegate',
      task: { prompt: 'add feature' },
      gates: {
        implement: {
          outcome: 'advance',
          payload: {
            summary: 'This summary should not appear',
            summaryTrustworthy: false,
          },
        },
      },
    });
    const msg = composeCommitMessage(state, ['packages/core/src/x/a.ts'], '/repo');
    expect(msg).not.toContain('This summary should not appear');
  });

  it('omits body when summaryTrustworthy is undefined (treat as false)', () => {
    const state = makeState({
      route: 'delegate',
      task: { prompt: 'add feature' },
      gates: {
        implement: {
          outcome: 'advance',
          payload: {
            summary: 'This summary should not appear',
          },
        },
      },
    });
    const msg = composeCommitMessage(state, ['packages/core/src/x/a.ts'], '/repo');
    expect(msg).not.toContain('This summary should not appear');
  });

  it('uses rework summary when available and summaryTrustworthy', () => {
    const state = makeState({
      route: 'delegate',
      task: { prompt: 'fix issue' },
      gates: {
        implement: {
          outcome: 'advance',
          payload: {
            summary: 'implement summary (should be ignored)',
            summaryTrustworthy: true,
          },
        },
        rework: {
          outcome: 'advance',
          payload: {
            summary: 'rework summary (this is used)',
            summaryTrustworthy: true,
          },
        },
      },
    });
    const msg = composeCommitMessage(state, ['packages/core/src/x/a.ts'], '/repo');
    expect(msg).toContain('rework summary (this is used)');
    expect(msg).not.toContain('implement summary');
  });

  // ── Plan footer (execute-plan only) ──────────────────────────────────────

  it('includes Plan: <basename> footer for execute-plan', () => {
    const state = makeState({
      route: 'execute-plan',
      task: {
        taskDescriptor: 'Task 1: add feature',
        planBasename: 'my-plan-2026-05-20.md',
        prompt: '',
      },
    });
    const msg = composeCommitMessage(state, ['packages/core/src/x/a.ts'], '/repo');
    expect(msg).toContain('Plan: my-plan-2026-05-20.md');
  });

  it('omits Plan footer for delegate route', () => {
    const state = makeState({
      route: 'delegate',
      task: {
        planBasename: 'some-plan.md',
        prompt: 'add feature',
      },
    });
    const msg = composeCommitMessage(state, ['packages/core/src/x/a.ts'], '/repo');
    expect(msg).not.toContain('Plan:');
  });

  it('omits Plan footer for retry route', () => {
    const state = makeState({
      route: 'retry',
      task: {
        planBasename: 'some-plan.md',
        prompt: 'fix issue',
      },
    });
    const msg = composeCommitMessage(state, ['packages/core/src/x/a.ts'], '/repo');
    expect(msg).not.toContain('Plan:');
  });

  // ── Rework annotation (preserved when applicable) ───────────────────────

  it('preserves rework annotation when review.verdict is changes_required and unaddressedFindingIds exist', () => {
    const state = makeState({
      route: 'delegate',
      task: { prompt: 'fix issue' },
      gates: {
        rework: {
          outcome: 'advance',
          payload: {
            summary: 'I fixed some things',
            unaddressedFindingIds: ['F1', 'F3'],
            summaryTrustworthy: true,
          },
        },
        review: {
          outcome: 'advance',
          payload: { verdict: 'changes_required' },
        },
      },
    });
    const msg = composeCommitMessage(state, ['packages/core/src/x/a.ts'], '/repo');
    expect(msg).toContain('Rework left 2 findings unaddressed: F1, F3.');
  });

  it('omits rework annotation when review verdict is approved', () => {
    const state = makeState({
      route: 'delegate',
      task: { prompt: 'fix issue' },
      gates: {
        rework: {
          outcome: 'advance',
          payload: {
            summary: 'fixed it',
            unaddressedFindingIds: ['F1'],
            summaryTrustworthy: true,
          },
        },
        review: {
          outcome: 'advance',
          payload: { verdict: 'approved' },
        },
      },
    });
    const msg = composeCommitMessage(state, ['packages/core/src/x/a.ts'], '/repo');
    expect(msg).not.toContain('Rework left');
  });

  it('omits rework annotation when unaddressedFindingIds is empty', () => {
    const state = makeState({
      route: 'delegate',
      task: { prompt: 'fix issue' },
      gates: {
        rework: {
          outcome: 'advance',
          payload: {
            summary: 'all fixed',
            unaddressedFindingIds: [],
            summaryTrustworthy: true,
          },
        },
        review: {
          outcome: 'advance',
          payload: { verdict: 'changes_required' },
        },
      },
    });
    const msg = composeCommitMessage(state, ['packages/core/src/x/a.ts'], '/repo');
    expect(msg).not.toContain('Rework left');
  });

  // ── Integration: full messages ──────────────────────────────────────────

  it('produces canonical execute-plan message with all parts', () => {
    const state = makeState({
      route: 'execute-plan',
      task: {
        taskDescriptor: 'Task 3: add buildCancelledResult helper',
        planBasename: '2026-05-20-journal-feature-plan.md',
        prompt: '',
      },
      gates: {
        implement: {
          outcome: 'advance',
          payload: {
            summary: 'Added the helper function with proper typing.',
            summaryTrustworthy: true,
          },
        },
      },
    });
    const msg = composeCommitMessage(state, ['packages/core/src/lifecycle/runtime.ts'], '/repo');
    const lines = msg.split('\n');
    expect(lines[0]).toBe('feat(lifecycle): add buildCancelledResult helper (Task 3)');
    expect(msg).toContain('Added the helper function with proper typing.');
    expect(msg).toContain('Plan: 2026-05-20-journal-feature-plan.md');
  });

  it('produces canonical delegate message', () => {
    const state = makeState({
      route: 'delegate',
      task: {
        prompt: 'add retry backoff to the fetch client',
      },
      gates: {
        implement: {
          outcome: 'advance',
          payload: {
            summary: 'Implemented exponential backoff.',
            summaryTrustworthy: true,
          },
        },
      },
    });
    const msg = composeCommitMessage(state, ['packages/core/src/runner-shell/fetch.ts'], '/repo');
    expect(msg).toMatch(/^feat\(runner-shell\): add retry backoff/);
    expect(msg).not.toContain('(Task');
    expect(msg).not.toContain('Plan:');
  });
});
