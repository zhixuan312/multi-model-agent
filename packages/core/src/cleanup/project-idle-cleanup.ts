import type { ProjectContext } from '../stores/project-context-registry.js';

export class ProjectIdleCleanup {
  constructor(private projects: Map<string, ProjectContext>) {}

  tick(idleThresholdMs: number): void {
    const now = Date.now();
    for (const [cwd, ctx] of this.projects) {
      if (now - ctx.lastActivityAt > idleThresholdMs) {
        this.projects.delete(cwd);
      }
    }
  }
}
