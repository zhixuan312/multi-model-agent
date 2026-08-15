import { InMemoryContextBlockStore, type ContextBlockStore } from './context-block-tool.js';

export interface ProjectContext {
  readonly cwd: string;
  readonly contextBlocks: ContextBlockStore;
  readonly createdAt: number;
  lastActivityAt: number;
}

export interface CreateProjectContextOptions {
  contextBlockStore?: ContextBlockStore;
  /** LRU bound for this project's blocks. Omitted, the store keeps its own default. */
  maxContextBlocks?: number;
}

export function createProjectContext(
  cwd: string,
  opts: CreateProjectContextOptions = {},
): ProjectContext {
  const now = Date.now();
  return {
    cwd,
    contextBlocks:
      opts.contextBlockStore ??
      new InMemoryContextBlockStore(
        opts.maxContextBlocks !== undefined ? { maxEntries: opts.maxContextBlocks } : {},
      ),
    createdAt: now,
    lastActivityAt: now,
  };
}
