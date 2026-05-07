import { describe, it, expect } from 'vitest';
import { verifyReferencedBlocks } from '../../packages/core/src/intake/verify-referenced-blocks.js';
import { InMemoryContextBlockStore, ContextBlockNotFoundError } from '../../packages/core/src/stores/context-block-tool.js';

describe('verifyReferencedBlocks', () => {
  it('passes when all blocks exist', () => {
    const store = new InMemoryContextBlockStore();
    store.register('x', { id: 'a' });
    expect(() => verifyReferencedBlocks({ contextBlockIds: ['a'] }, store)).not.toThrow();
  });

  it('throws ContextBlockNotFoundError when any missing', () => {
    const store = new InMemoryContextBlockStore();
    expect(() => verifyReferencedBlocks({ contextBlockIds: ['nope'] }, store)).toThrow(ContextBlockNotFoundError);
  });

  it('passes when contextBlockIds is undefined', () => {
    const store = new InMemoryContextBlockStore();
    expect(() => verifyReferencedBlocks({}, store)).not.toThrow();
  });

  it('passes when contextBlockIds is empty', () => {
    const store = new InMemoryContextBlockStore();
    expect(() => verifyReferencedBlocks({ contextBlockIds: [] }, store)).not.toThrow();
  });

  it('throws on first missing id when multiple are missing', () => {
    const store = new InMemoryContextBlockStore();
    store.register('x', { id: 'exists' });
    expect(() => verifyReferencedBlocks({ contextBlockIds: ['exists', 'a', 'b'] }, store)).toThrow(ContextBlockNotFoundError);
  });
});
