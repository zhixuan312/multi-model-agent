import { describe, it, expect } from 'vitest';
import { composeCommitMessage } from '@zhixuan92/multi-model-agent-core/lifecycle/auto-commit';

describe('composeCommitMessage', () => {
  it('composes "type(scope): subject" with body', () => {
    const msg = composeCommitMessage({ type: 'feat', scope: 'core', subject: 'add x', body: 'why\n\nbecause.' });
    expect(msg).toBe('feat(core): add x\n\nwhy\n\nbecause.');
  });

  it('omits scope when absent', () => {
    expect(composeCommitMessage({ type: 'fix', subject: 'bar' })).toBe('fix: bar');
  });

  it('omits body when absent', () => {
    expect(composeCommitMessage({ type: 'docs', scope: 'spec', subject: 'baz' })).toBe('docs(spec): baz');
  });
});
