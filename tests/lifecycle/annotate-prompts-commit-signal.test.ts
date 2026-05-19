import { describe, it, expect } from 'vitest';
import { annotatePromptWrite } from '../../packages/core/src/lifecycle/annotate-prompts.js';

describe('annotate-prompts — reads commit signal from active gate', () => {
  it('serializes committed=true when state.gates.commit.payload.kind=committed, even if state.commits is empty', () => {
    const state: any = {
      route: 'delegate',
      reviewPolicy: 'full',
      commits: [],  // legacy mirror empty
      gates: {
        commit: { payload: { kind: 'committed', commitSha: 'abc', commitMessage: 's', filesChanged: ['x.ts'] } },
      },
      reviewVerdict: 'approved',
      lastRunResult: {} as any,
    };
    const prompt = annotatePromptWrite(state);
    expect(prompt).toMatch(/committed.{0,3}true/i);
  });

  it('serializes committed=false when no commit gate payload', () => {
    const state: any = {
      route: 'delegate',
      reviewPolicy: 'full',
      commits: [{ sha: 'abc' }],  // legacy mirror populated (should be ignored)
      gates: { commit: undefined },
      reviewVerdict: 'approved',
      lastRunResult: {} as any,
    };
    const prompt = annotatePromptWrite(state);
    expect(prompt).not.toMatch(/committed.{0,3}true/i);
  });
});
