import type { TaskSpec } from '../types.js';
import type { MultiModelConfig } from '../types.js';
import type { DraftTask, SourceRoute } from './types.js';

export const OUTPUT_CONTRACT_CLAUSES: Partial<Record<SourceRoute, string>> = {
  review_code: 'Provide a structured review with findings and recommendations.',
  debug_task: 'Use hypothesis-driven debugging: identify root cause, propose fix, verify.',
  verify_work: 'For each checklist item, indicate pass/fail and provide evidence.',
  audit_document: 'Provide a structured audit report with findings and severity.',
  execute_plan: 'Implement the task fully. Report: which task heading you matched, what files were created or modified, and any issues encountered. If no unique matching task was found, report that explicitly and do not implement anything.',
};

export const ROUTE_DEFAULTS: Record<SourceRoute, Partial<TaskSpec>> = {
  delegate_tasks: {},
  review_code: { agentType: 'complex', reviewPolicy: 'full' },
  debug_task: { agentType: 'complex', reviewPolicy: 'full', maxReviewRounds: 1 },
  verify_work: { agentType: 'standard', reviewPolicy: 'spec_only' },
  audit_document: { agentType: 'complex', reviewPolicy: 'off' },
  execute_plan: { agentType: 'standard', reviewPolicy: 'full' },
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
    agentType: agentType as 'standard' | 'complex',
    reviewPolicy: draft.reviewPolicy ?? routeDefaults.reviewPolicy,
    maxReviewRounds: routeDefaults.maxReviewRounds,
    tools: config.defaults?.tools ?? 'full',
    timeoutMs: config.defaults?.timeoutMs ?? 1_800_000,
    maxCostUSD: config.defaults?.maxCostUSD ?? 10,
    sandboxPolicy: config.defaults?.sandboxPolicy ?? 'cwd-only',
    briefQualityPolicy: 'off',
    cwd: process.cwd(),
  };
}