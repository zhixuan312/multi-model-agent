import { InMemoryContextBlockStore, type ContextBlockStore } from './context-block-tool.js';

export interface ProjectContext {
  readonly cwd: string;
  readonly contextBlocks: ContextBlockStore;
  readonly createdAt: number;
  lastActivityAt: number;
  pendingReservations: number;
}

export interface CreateProjectContextOptions {
  contextBlockStore?: ContextBlockStore;
}

export function createProjectContext(
  cwd: string,
  opts: CreateProjectContextOptions = {},
): ProjectContext {
  const now = Date.now();
  return {
    cwd,
    contextBlocks: opts.contextBlockStore ?? new InMemoryContextBlockStore(),
    createdAt: now,
    lastActivityAt: now,
    pendingReservations: 0,
  };
}
