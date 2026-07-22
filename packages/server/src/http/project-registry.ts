import { createProjectContext, type ProjectContext } from '@zhixuan92/multi-model-agent-core';
import { validateCwd } from './cwd-validator.js';

export type ReserveError = 'project_cap' | 'invalid_cwd' | 'missing_cwd' | 'cwd_not_dir' | 'forbidden_cwd';

export type ReserveResult =
  | { ok: true; projectContext: ProjectContext; created: boolean }
  | { ok: false; error: ReserveError; message: string };

export interface ProjectRegistryOptions {
  cap: number;
  onProjectCreated?: (cwd: string) => void;
  /** Returns true when the project at this canonical cwd has in-flight work and
   *  must not be evicted. Wired to `TaskRegistry.countActive(cwd) > 0` in
   *  production — `pendingReservations` is NOT a reliable busy signal because it
   *  is cancelled at dispatch, before the async task runs. */
  isBusy?: (canonicalCwd: string) => boolean;
}

export class ProjectRegistry {
  private readonly map = new Map<string, ProjectContext>();
  private readonly cap: number;
  private readonly onProjectCreated?: (cwd: string) => void;
  private readonly isBusy?: (canonicalCwd: string) => boolean;

  constructor(options: ProjectRegistryOptions) {
    this.cap = options.cap;
    this.onProjectCreated = options.onProjectCreated;
    this.isBusy = options.isBusy;
  }

  /** Evict the least-recently-active project that is safe to drop — no in-flight
   *  work (`isBusy` false) and no retained context blocks (a caller may still
   *  reference them via contextBlockIds). Returns true if one was evicted. This
   *  keeps the cap from becoming a permanent lockout once `cap` distinct cwds
   *  have been seen over the server's lifetime. */
  private evictIdleLRU(): boolean {
    let victim: string | null = null;
    let oldest = Infinity;
    for (const [key, pc] of this.map) {
      if (this.isBusy?.(key)) continue;
      if (pc.contextBlocks.size > 0) continue;
      if (pc.lastActivityAt < oldest) {
        oldest = pc.lastActivityAt;
        victim = key;
      }
    }
    if (victim === null) return false;
    this.map.delete(victim);
    return true;
  }

  /** Synchronous lookup-or-create with cap enforcement. Increments pendingReservations on success. */
  reserveProject(cwd: string): ReserveResult {
    const v = validateCwd(cwd);
    if (!v.ok) return { ok: false, error: v.error, message: v.message };
    const key = v.canonicalCwd;
    const existing = this.map.get(key);
    if (existing) {
      existing.pendingReservations += 1;
      return { ok: true, projectContext: existing, created: false };
    }
    if (this.map.size >= this.cap && !this.evictIdleLRU()) {
      return {
        ok: false,
        error: 'project_cap',
        message: `server at ${this.cap} projects, all with in-flight work or retained context blocks; wait for active tasks to finish or delete unused context blocks`,
      };
    }
    const pc = createProjectContext(key);
    pc.pendingReservations = 1;
    this.map.set(key, pc);
    this.onProjectCreated?.(key);
    return { ok: true, projectContext: pc, created: true };
  }

  /** Called if a reserved project's work completes. `canonicalCwd` must match `projectContext.cwd`. No-op if unknown. */
  cancelReservation(canonicalCwd: string): void {
    const pc = this.map.get(canonicalCwd);
    if (!pc) return;
    if (pc.pendingReservations > 0) pc.pendingReservations -= 1;
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
}
