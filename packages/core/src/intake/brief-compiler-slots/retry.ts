import type { BriefSlotFiller } from '../brief-compiler.js';
import type { BatchRegistry } from '../../stores/batch-registry.js';

export interface RetryInput {
  batchId: string;
  retryableFor: number[];
  cwd?: string;
}

export interface RetryBrief {
  taskIndex: number;
  brief: string;
  cwd: string;
  agentType: 'standard' | 'complex';
  reviewPolicy: 'full' | 'quality_only' | 'diff_only' | 'none';
  contextBlockIds: string[];
  originalTaskIndex: number;
  /** Inherited from the original tool — used for runtime budget selection. */
  inheritedToolCategory: 'artifact_producing' | 'read_only' | 'research' | 'assist';
}

export function makeRetrySlot(registry: BatchRegistry): BriefSlotFiller<RetryInput, RetryBrief[]> {
  return (input) => {
    const original = registry.get(input.batchId);
    if (!original) throw new Error(`unknown batchId for retry: ${input.batchId}`);
    const { toolCategory, tasks, terminalBlockIds } = original;
    if (!toolCategory || (toolCategory as string) === 'assist') {
      throw new Error(
        `retry: original batch '${input.batchId}' has missing or invalid toolCategory ` +
        `'${toolCategory}' — refusing to retry with 'assist' (assist is route-level only)`,
      );
    }
    if (!tasks) {
      throw new Error(`retry: original batch '${input.batchId}' has no stored tasks in registry`);
    }
    return input.retryableFor.map((origIdx, i) => {
      const origTask = tasks[origIdx];
      if (!origTask) {
        throw new Error(
          `retry: task index ${origIdx} out of range for batch '${input.batchId}' ` +
          `(tasks length: ${tasks.length})`,
        );
      }
      const priorBlock = terminalBlockIds?.get(origIdx);
      return {
        taskIndex: i,
        brief: origTask.brief,
        cwd: input.cwd ?? origTask.cwd,
        agentType: origTask.agentType,
        reviewPolicy: origTask.reviewPolicy,
        contextBlockIds: [
          ...(origTask.contextBlockIds ?? []),
          ...(priorBlock ? [priorBlock] : []),
        ],
        originalTaskIndex: origIdx,
        inheritedToolCategory: toolCategory,
      };
    });
  };
}
