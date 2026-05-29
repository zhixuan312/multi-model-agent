// Post-task verifier for declared output files.
// Callers set ctx.outputTargets in task-runner; the implementer stage handler
// invokes checkOutputTargets() post-task to verify each path exists on disk.

import { existsSync } from 'node:fs';

/**
 * Returns the subset of `outputTargets` that do NOT exist on disk.
 * Empty array means all targets exist. Caller decides whether non-empty
 * is a failure (typically yes — surface as a structured finding).
 */
export function checkOutputTargets(outputTargets: string[]): string[] {
  return outputTargets.filter((p) => !existsSync(p));
}
