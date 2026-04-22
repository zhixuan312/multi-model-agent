import { InMemoryContextBlockStore } from './context/context-block-store.js';
import { ClarificationStore } from './intake/clarification-store.js';
import { BatchCache } from './batch-cache.js';

export interface ProjectContext {
  readonly cwd: string;
  readonly contextBlocks: InMemoryContextBlockStore;
  readonly batchCache: BatchCache;
  readonly clarifications: ClarificationStore;
  readonly createdAt: number;
  lastSeenAt: number;
  readonly activeSessions: Set<string>;
  activeRequests: number;
  pendingReservations: number;
}

export function createProjectContext(cwd: string): ProjectContext {
  const now = Date.now();
  return {
    cwd,
    contextBlocks: new InMemoryContextBlockStore(),
    batchCache: new BatchCache(),
    clarifications: new ClarificationStore(),
    createdAt: now,
    lastSeenAt: now,
    activeSessions: new Set<string>(),
    activeRequests: 0,
    pendingReservations: 0,
  };
}
