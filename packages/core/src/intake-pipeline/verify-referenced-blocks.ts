import { ContextBlockNotFoundError, type ContextBlockStore } from '../context/context-block-store.js';

export function verifyReferencedBlocks(input: { contextBlockIds?: string[] }, store: ContextBlockStore): void {
  const ids = input.contextBlockIds ?? [];
  const missing = ids.filter(id => !store.get(id));
  if (missing.length > 0) {
    throw new ContextBlockNotFoundError(missing[0]);
  }
}
