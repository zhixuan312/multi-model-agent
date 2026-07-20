import { InMemoryContextBlockStore, type ContextBlockStore } from './context-block-tool.js';

export interface ProjectContext {
  readonly cwd: string;
  readonly contextBlocks: ContextBlockStore;
  readonly createdAt: number;
  lastActivityAt: number;
  activeRequests: number;
  readonly activeSessions: Set<string>;
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
    activeSessions: new Set<string>(),
    activeRequests: 0,
    pendingReservations: 0,
  };
}
