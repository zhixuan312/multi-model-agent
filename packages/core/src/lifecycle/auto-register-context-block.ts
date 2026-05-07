import type { RunResult } from '../types.js';
import type { ContextBlockStore } from '../stores/context-block-tool.js';

/**
 * Register usable task outputs as a combined context block.
 *
 * Inlined identically in 4 executors (execute-plan, verify, debug, audit).
 * Promoted here so the generic task executor and remaining per-tool
 * executors share a single implementation.
 */
export function autoRegisterContextBlock(
  results: RunResult[],
  store: ContextBlockStore | undefined,
): string | undefined {
  if (!store) return undefined;
  const usable = results.filter(r => !r.outputIsDiagnostic && r.output.trim().length > 0);
  if (usable.length === 0) return undefined;
  const combined = usable.map(r => r.output).join('\n\n---\n\n');
  const { id } = store.register(combined);
  return id;
}
