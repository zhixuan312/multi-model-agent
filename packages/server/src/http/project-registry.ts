import { createProjectContext, type ProjectContext } from '@zhixuan92/multi-model-agent-core';
import { validateCwd } from './cwd-validator.js';

export type ReserveError = 'project_cap' | 'invalid_cwd' | 'missing_cwd' | 'cwd_not_dir' | 'forbidden_cwd';

export type ReserveResult =
  | { ok: true; projectContext: ProjectContext; created: boolean }
  | { ok: false; error: ReserveError; message: string };

export interface ProjectRegistryOptions {
  cap: number;
  onProjectCreated?: (cwd: string) => void;
}

export class ProjectRegistry {
  private readonly map = new Map<string, ProjectContext>();
  private readonly cap: number;
  private readonly onProjectCreated?: (cwd: string) => void;

  constructor(options: ProjectRegistryOptions) {
    this.cap = options.cap;
    this.onProjectCreated = options.onProjectCreated;
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
    if (this.map.size >= this.cap) {
      return { ok: false, error: 'project_cap', message: `server at ${this.cap} projects; close some connections and retry` };
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
