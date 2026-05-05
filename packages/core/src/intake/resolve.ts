import type { TaskSpec } from '../types.js';
import type { MultiModelConfig } from '../types.js';
import type { DraftTask, SourceRoute } from './types.js';
import { DEFAULT_TASK_TIMEOUT_MS } from '../config/schema.js';
import { ROUTE_DEFAULTS } from './field-inferer.js';

/**
 * Worker output contract per route.
 *
 * The 5 read-only routes (audit / review / verify / debug / investigate) no
 * longer carry a structured-output contract — the quality reviewer extracts
 * findings from the worker's free-form narrative in one pass. See
 * packages/core/src/review/quality-only-prompts.ts.
 *
 * The artifact route `execute_plan` keeps its narrative contract.
 */
export const OUTPUT_CONTRACT_CLAUSES: Partial<Record<SourceRoute, string>> = {
  execute_plan: 'Implement the task fully. Report: which task heading you matched, what files were created or modified, and any issues encountered. If no unique matching task was found, report that explicitly and do not implement anything.',
};

export function resolveDraft(
  draft: DraftTask,
  config: MultiModelConfig,
): TaskSpec {
  const routeDefaults = ROUTE_DEFAULTS[draft.source.route];

  const agentType = draft.agentType ?? routeDefaults.agentType ?? 'standard';

  const outputContract = OUTPUT_CONTRACT_CLAUSES[draft.source.route];
  const prompt = outputContract && !draft.prompt.includes(outputContract)
    ? `${draft.prompt}\n\n${outputContract}`
    : draft.prompt;

  return {
    prompt,
    done: draft.done,
    filePaths: draft.filePaths,
    agentType,
    reviewPolicy: draft.reviewPolicy ?? routeDefaults.reviewPolicy,
    tools: config.defaults?.tools ?? 'full',
    timeoutMs: config.defaults?.timeoutMs ?? DEFAULT_TASK_TIMEOUT_MS,
    maxCostUSD: config.defaults?.maxCostUSD ?? 10,
    sandboxPolicy: config.defaults?.sandboxPolicy ?? 'cwd-only',
    briefQualityPolicy: 'off',
    verifyCommand: draft.verifyCommand,
    skipCompletionHeuristic: draft.skipCompletionHeuristic,
  };
}
