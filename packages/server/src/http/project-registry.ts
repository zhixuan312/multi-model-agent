import { createProjectContext, type ProjectContext, BatchRegistry } from '@zhixuan92/multi-model-agent-core';
import { validateCwd } from './cwd-validator.js';

export type ReserveError = 'project_cap' | 'invalid_cwd' | 'missing_cwd' | 'cwd_not_dir';

export type ReserveResult =
  | { ok: true; projectContext: ProjectContext; created: boolean }
  | { ok: false; error: ReserveError; message: string };

export interface ProjectRegistryOptions {
  cap: number;
  idleEvictionMs: number;
  evictionIntervalMs: number;
  onProjectCreated?: (cwd: string) => void;
  onProjectEvicted?: (cwd: string, idleMs: number) => void;
}

export class ProjectRegistry {
  private readonly map = new Map<string, ProjectContext>();
  private readonly cap: number;
  private readonly idleEvictionMs: number;
  private readonly evictionIntervalMs: number;
  private evictionTimer: NodeJS.Timeout | null = null;
  private readonly onProjectCreated?: (cwd: string) => void;
  private readonly onProjectEvicted?: (cwd: string, idleMs: number) => void;

  constructor(options: ProjectRegistryOptions) {
    this.cap = options.cap;
    this.idleEvictionMs = options.idleEvictionMs;
    this.evictionIntervalMs = options.evictionIntervalMs;
    this.onProjectCreated = options.onProjectCreated;
    this.onProjectEvicted = options.onProjectEvicted;
  }

  startEvictionTimer(): void {
    if (this.evictionTimer) return;
    this.evictionTimer = setInterval(() => this.evictIdle(), this.evictionIntervalMs);
    this.evictionTimer.unref?.();
  }

  stopEvictionTimer(): void {
    if (this.evictionTimer) clearInterval(this.evictionTimer);
    this.evictionTimer = null;
  }

  /** Synchronous lookup-or-create with cap enforcement. Increments pendingReservations on success. */
  reserveProject(cwd: string): ReserveResult {
    const v = validateCwd(cwd);
    if (!v.ok) return { ok: false, error: v.error, message: v.message };
    const key = v.canonicalCwd;
    const existing = this.map.get(key);
    if (existing) {
      existing.pendingReservations += 1;
      existing.lastActivityAt = Date.now();
      return { ok: true, projectContext: existing, created: false };
    }
    if (this.map.size >= this.cap) {
      return { ok: false, error: 'project_cap', message: `server at ${this.cap} projects; close some connections and retry` };
    }
    const pc = createProjectContext(key);
    pc.pendingReservations = 1;
    this.map.set(key, pc);
    this.onProjectCreated?.(key);
    return { ok: true, projectContext: pc, created: true };
  }

  /**
   * Called from onsessioninitialized. Decrements pendingReservations and registers the session.
   * `canonicalCwd` MUST be the `.cwd` value returned from a prior `reserveProject` call.
   */
  attachSession(canonicalCwd: string, sessionId: string): void {
    const pc = this.map.get(canonicalCwd);
    if (!pc) throw new Error(`attachSession: no project for ${canonicalCwd} (did you pass the raw cwd instead of projectContext.cwd?)`);
    pc.activeSessions.add(sessionId);
    if (pc.pendingReservations > 0) pc.pendingReservations -= 1;
    pc.lastActivityAt = Date.now();
  }

  /** Detach a session. `canonicalCwd` must match `projectContext.cwd`. No-op if unknown. */
  detachSession(canonicalCwd: string, sessionId: string): void {
    const pc = this.map.get(canonicalCwd);
    if (!pc) return;
    pc.activeSessions.delete(sessionId);
    pc.lastActivityAt = Date.now();
  }

  /** Called if attachSession never fires. `canonicalCwd` must match `projectContext.cwd`. */
  cancelReservation(canonicalCwd: string): void {
    const pc = this.map.get(canonicalCwd);
    if (!pc) return;
    if (pc.pendingReservations > 0) pc.pendingReservations -= 1;
    pc.lastActivityAt = Date.now();
  }

  /** Look up a project by its canonical cwd. */
  get(canonicalCwd: string): ProjectContext | undefined {
    return this.map.get(canonicalCwd);
  }

  get size(): number {
    return this.map.size;
  }

  *entries(): IterableIterator<[string, ProjectContext]> {
    yield* this.map.entries();
  }

  /**
   * Returns true if the project context is idle and eligible for eviction.
   * Gates on: no active HTTP requests, no active batches in the registry,
   * no active sessions, no pending reservations, and idle for at least idleTimeoutMs.
   */
  isIdleFor(pc: ProjectContext, now: number, idleTimeoutMs: number, batchRegistry: BatchRegistry): boolean {
    return (
      pc.activeRequests === 0 &&
      batchRegistry.countActiveForProject(pc.cwd) === 0 &&
      pc.activeSessions.size === 0 &&
      pc.pendingReservations === 0 &&
      (now - pc.lastActivityAt) > idleTimeoutMs
    );
  }

  evictIdle(): void {
    const now = Date.now();
    const victims: string[] = [];
    for (const [cwd, pc] of this.map.entries()) {
      if (
        pc.activeSessions.size === 0 &&
        pc.activeRequests === 0 &&
        pc.pendingReservations === 0 &&
        now - pc.lastActivityAt > this.idleEvictionMs
      ) {
        victims.push(cwd);
      }
    }
    for (const cwd of victims) {
      const pc = this.map.get(cwd)!;
      pc.contextBlocks.clear();
      pc.batchCache.clear();
      pc.clarifications.clear();
      this.map.delete(cwd);
      this.onProjectEvicted?.(cwd, now - pc.lastActivityAt);
    }
  }

  clear(): void {
    for (const pc of this.map.values()) {
      pc.contextBlocks.clear();
      pc.batchCache.clear();
      pc.clarifications.clear();
    }
    this.map.clear();
  }
}
