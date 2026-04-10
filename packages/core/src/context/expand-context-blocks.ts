import { ContextBlockNotFoundError, type ContextBlockStore } from './context-block-store.js';
import type { TaskSpec } from '../types.js';

/**
 * Separator inserted between resolved blocks and between the last block
 * and the original prompt. Exact string is load-bearing — tests assert on
 * it, and the hash inputs in `onInitialRequest` depend on the rendered
 * prompt being byte-stable across dispatches.
 */
const SEPARATOR = '\n\n---\n\n';

/**
 * Expands a task's `contextBlockIds` against a `ContextBlockStore`,
 * returning a NEW `TaskSpec` whose `prompt` has the resolved blocks
 * prepended (in the order they appear in `contextBlockIds`) with
 * `SEPARATOR` between each block and before the original prompt.
 *
 * The returned task has `contextBlockIds` removed so downstream code
 * cannot accidentally double-expand.
 *
 * If the task has no `contextBlockIds` (or the array is empty), or if
 * no store is provided, the task is returned unchanged — the caller
 * does not have to special-case the no-op path.
 *
 * Throws `ContextBlockNotFoundError` synchronously on the first missing
 * id so the caller gets a clear error pointing to the offending block.
 */
export function expandContextBlocks(
  task: TaskSpec,
  store: ContextBlockStore | undefined,
): TaskSpec {
  if (!task.contextBlockIds || task.contextBlockIds.length === 0) return task;
  if (!store) return task;

  const blocks: string[] = [];
  for (const id of task.contextBlockIds) {
    const content = store.get(id);
    if (content === undefined) {
      throw new ContextBlockNotFoundError(id);
    }
    blocks.push(content);
  }

  const expanded = blocks.join(SEPARATOR) + SEPARATOR + task.prompt;
  // Strip contextBlockIds from the returned task so a second pass through
  // expandContextBlocks is a no-op (defence in depth against double-
  // expansion if runtime-plumbing calls it twice).
  const { contextBlockIds, ...rest } = task;
  void contextBlockIds;
  return { ...rest, prompt: expanded };
}
