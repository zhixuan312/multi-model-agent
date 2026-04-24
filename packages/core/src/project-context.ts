import { InMemoryContextBlockStore } from './context/context-block-store.js';
import { ClarificationStore } from './intake/clarification-store.js';
import { BatchCache } from './batch-cache.js';

export interface ProjectContext {
  readonly cwd: string;
  readonly contextBlocks: InMemoryContextBlockStore;
  /** Per-project terminal-only retention index; authoritative live-batch lookup is via BatchRegistry.countActiveForProject(cwd). */
  readonly batchCache: BatchCache;
  readonly clarifications: ClarificationStore;
  readonly createdAt: number;
  /** Wall-clock ms of last activity on this project context (HTTP request, session attach/detach). */
  lastActivityAt: number;
  /** HTTP requests currently in-flight for this cwd. */
  activeRequests: number;
  // NOTE: no activeBatches field — derived from BatchRegistry via countActiveForProject(cwd)
  readonly activeSessions: Set<string>;
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
    lastActivityAt: now,
    activeSessions: new Set<string>(),
    activeRequests: 0,
    pendingReservations: 0,
  };
}
