import { describe, it, expect } from 'vitest';
import { expandContextBlocks } from '../../packages/core/src/context/expand-context-blocks.js';
import {
  InMemoryContextBlockStore,
  ContextBlockNotFoundError,
} from '../../packages/core/src/context/context-block-store.js';
import type { TaskSpec } from '../../packages/core/src/types.js';

function makeTask(prompt: string, contextBlockIds?: string[]): TaskSpec {
  return { prompt, tier: 'standard', requiredCapabilities: [], contextBlockIds };
}

describe('expandContextBlocks', () => {
  it('returns the task unchanged when contextBlockIds is empty', () => {
    const store = new InMemoryContextBlockStore();
    const task = makeTask('hello');
    const expanded = expandContextBlocks(task, store);
    expect(expanded).toEqual(task);
  });

  it('returns the task unchanged when no store is provided', () => {
    const task = makeTask('hello', ['x']);
    const expanded = expandContextBlocks(task, undefined);
    expect(expanded).toEqual(task);
  });

  it('expands a single block before the prompt', () => {
    const store = new InMemoryContextBlockStore();
    store.register('background context', { id: 'bg' });
    const task = makeTask('do the thing', ['bg']);
    const expanded = expandContextBlocks(task, store);
    expect(expanded.prompt).toBe('background context\n\n---\n\ndo the thing');
    expect(expanded.contextBlockIds).toBeUndefined();
  });

  it('expands multiple blocks in order', () => {
    const store = new InMemoryContextBlockStore();
    store.register('first', { id: 'a' });
    store.register('second', { id: 'b' });
    const task = makeTask('the task', ['a', 'b']);
    const expanded = expandContextBlocks(task, store);
    expect(expanded.prompt).toBe('first\n\n---\n\nsecond\n\n---\n\nthe task');
  });

  it('order matters: ["a", "b"] and ["b", "a"] produce different prompts', () => {
    const store = new InMemoryContextBlockStore();
    store.register('first', { id: 'a' });
    store.register('second', { id: 'b' });
    const ab = expandContextBlocks(makeTask('t', ['a', 'b']), store);
    const ba = expandContextBlocks(makeTask('t', ['b', 'a']), store);
    expect(ab.prompt).not.toBe(ba.prompt);
  });

  it('throws ContextBlockNotFoundError on missing id', () => {
    const store = new InMemoryContextBlockStore();
    const task = makeTask('t', ['unknown']);
    expect(() => expandContextBlocks(task, store)).toThrow(ContextBlockNotFoundError);
  });

  it('determinism: same inputs → byte-identical output, twice in a row', () => {
    const store = new InMemoryContextBlockStore();
    store.register('content', { id: 'x' });
    const task = makeTask('t', ['x']);
    const a = expandContextBlocks(task, store);
    const b = expandContextBlocks(task, store);
    expect(a.prompt).toBe(b.prompt);
  });
});
