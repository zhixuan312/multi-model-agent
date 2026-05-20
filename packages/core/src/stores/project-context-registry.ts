import { InMemoryContextBlockStore, type ContextBlockStore } from './context-block-tool.js';
import { BatchCache } from './batch-cache.js';

export interface ProjectContext {
  readonly cwd: string;
  /** In-memory context-block store (the only implementation). */
  readonly contextBlocks: ContextBlockStore;
  /** Per-project terminal-only retention index; authoritative live-batch lookup is via BatchRegistry.countActiveForProject(cwd). */
  readonly batchCache: BatchCache;
  readonly createdAt: number;
  /** Wall-clock ms of last activity on this project context (HTTP request, session attach/detach). */
  lastActivityAt: number;
  /** HTTP requests currently in-flight for this cwd. */
  activeRequests: number;
  readonly activeSessions: Set<string>;
  pendingReservations: number;
}

export interface CreateProjectContextOptions {
  /** Override the context-block store (tests may inject a pre-seeded instance). */
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
    batchCache: new BatchCache(),
    createdAt: now,
    lastActivityAt: now,
    activeSessions: new Set<string>(),
    activeRequests: 0,
    pendingReservations: 0,
  };
}

/** Alias retained for call sites that explicitly want an in-memory project
 *  context. Identical to createProjectContext now that in-memory is the only store. */
export function createInMemoryProjectContext(cwd: string): ProjectContext {
  return createProjectContext(cwd);
}
