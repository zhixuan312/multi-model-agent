import { describe, it, expect } from 'vitest';
import { composeTerminalHeadline } from '@zhixuan92/multi-model-agent-core';

describe('composeTerminalHeadline', () => {
  it('zero tasks succeeded', () => {
    expect(composeTerminalHeadline({ tool: 'audit', tasksTotal: 0, tasksCompleted: 0 }))
      .toBe('audit: no tasks executed');
  });

  it('all tasks complete', () => {
    expect(composeTerminalHeadline({ tool: 'review', tasksTotal: 3, tasksCompleted: 3 }))
      .toBe('review: 3/3 tasks complete');
  });

  it('partial completion', () => {
    expect(composeTerminalHeadline({ tool: 'debug', tasksTotal: 5, tasksCompleted: 2 }))
      .toBe('debug: 2/5 tasks complete');
  });

  it('never returns empty string for any sane input', () => {
    const out = composeTerminalHeadline({ tool: 'x', tasksTotal: 0, tasksCompleted: 0 });
    expect(out).not.toBe('');
    expect(out.length).toBeGreaterThan(0);
  });
});
