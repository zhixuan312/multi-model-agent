import { describe, it, expect } from 'vitest';
import { compileDelegateTasks } from '../../../packages/core/src/intake/compilers/delegate.js';

describe('delegate compiler', () => {
  it('creates one draft per task with sequential indices', () => {
    const drafts = compileDelegateTasks([
      { prompt: 'task 1', done: 'done 1' },
      { prompt: 'task 2' },
    ], 'req-abc');
    expect(drafts).toHaveLength(2);
    expect(drafts[0].draftId).toBe('req-abc:0:root');
    expect(drafts[0].prompt).toBe('task 1');
    expect(drafts[0].done).toBe('done 1');
    expect(drafts[1].draftId).toBe('req-abc:1:root');
  });

  it('sets source.route to delegate_tasks', () => {
    const drafts = compileDelegateTasks([{ prompt: 'hello' }], 'req');
    expect(drafts[0].source.route).toBe('delegate_tasks');
  });

  it('passes through optional fields', () => {
    const drafts = compileDelegateTasks([{
      prompt: 'task',
      done: 'done',
      filePaths: ['src/a.ts'],
      agentType: 'complex',
      contextBlockIds: ['blk-1'],
    }], 'req');
    expect(drafts[0].filePaths).toEqual(['src/a.ts']);
    expect(drafts[0].agentType).toBe('complex');
    expect(drafts[0].contextBlockIds).toEqual(['blk-1']);
  });

  it('clones originalInput (does not share reference)', () => {
    const input = { prompt: 'task' };
    const drafts = compileDelegateTasks([input], 'req');
    (drafts[0].source as { originalInput: object }).originalInput = { prompt: 'mutated' };
    expect(input.prompt).toBe('task');
  });
});