import { InMemoryContextBlockStore, type ContextBlockStore } from './context-block-tool.js';
import { FileBackedContextBlockStore } from './file-backed-context-block-store.js';
import { BatchCache } from './batch-cache.js';

export interface ProjectContext {
  readonly cwd: string;
  /** 4.0.3+: store is the interface — concrete class chosen at
   *  createProjectContext (file-backed by default, in-memory in tests). */
  readonly contextBlocks: ContextBlockStore;
  /** Per-project terminal-only retention index; authoritative live-batch lookup is via BatchRegistry.countActiveForProject(cwd). */
  readonly batchCache: BatchCache;
  readonly createdAt: number;
  /** Wall-clock ms of last activity on this project context (HTTP request, session attach/detach). */
  lastActivityAt: number;
  /** HTTP requests currently in-flight for this cwd. */
  activeRequests: number;
  // NOTE: no activeBatches field — derived from BatchRegistry via countActiveForProject(cwd)
  readonly activeSessions: Set<string>;
  pendingReservations: number;
}

export interface CreateProjectContextOptions {
  /** Override the context-block store. When omitted, defaults to a
   *  FileBackedContextBlockStore rooted at
   *  `~/.multi-model-agent/context-blocks/<sha256(cwd)>/` so blocks
   *  survive daemon restarts (Gap 4 fix) without polluting the project
   *  tree. Tests pass an InMemoryContextBlockStore to avoid filesystem
   *  side effects. */
  contextBlockStore?: ContextBlockStore;
}

export function createProjectContext(
  cwd: string,
  opts: CreateProjectContextOptions = {},
): ProjectContext {
  const now = Date.now();
  return {
    cwd,
    contextBlocks: opts.contextBlockStore ?? new FileBackedContextBlockStore(cwd),
    batchCache: new BatchCache(),
    createdAt: now,
    lastActivityAt: now,
    activeSessions: new Set<string>(),
    activeRequests: 0,
    pendingReservations: 0,
  };
}

/** Test-only convenience constructor that uses the in-memory store. Call
 *  sites that need filesystem isolation (and don't care about persistence)
 *  should use this instead of passing the option each time. */
export function createInMemoryProjectContext(cwd: string): ProjectContext {
  return createProjectContext(cwd, { contextBlockStore: new InMemoryContextBlockStore() });
}
