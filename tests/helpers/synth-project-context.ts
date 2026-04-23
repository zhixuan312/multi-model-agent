import { createProjectContext, type ProjectContext } from '../../packages/core/src/project-context.js';

/** Helper for stdio-path tests: synthesize a ProjectContext from cwd (default: process.cwd()). */
export function synthesizeStdioProjectContext(cwd?: string): ProjectContext {
  return createProjectContext(cwd ?? process.cwd());
}
