import type { TaskSpec } from '../types.js';
import type { MultiModelConfig } from '../types.js';
import type { DraftTask, SourceRoute } from './types.js';

export const OUTPUT_CONTRACT_CLAUSES: Partial<Record<SourceRoute, string>> = {
  review_code: 'Your output MUST include a `findings[]` array (JSON, alongside any prose). Each finding has: `id` (string), `severity` (\'high\'|\'medium\'|\'low\'), `file` (string|null), `line` (number 1-indexed|null), `claim` (string), `sourceQuote?` (string), `suggestedFix?` (string). For project-level findings (no specific file), set `file` and `line` to null. For multi-line findings, point `line` at the start of the cited region and use `sourceQuote` for the full text. Each finding should describe a code-level concern with a suggested fix where applicable.',
  debug_task: 'Your output MUST include a `findings[]` array (JSON, alongside any prose). Each finding has: `id` (string), `severity` (\'high\'|\'medium\'|\'low\'), `file` (string|null), `line` (number 1-indexed|null), `claim` (string), `sourceQuote?` (string), `suggestedFix?` (string). For project-level findings (no specific file), set `file` and `line` to null. For multi-line findings, point `line` at the start of the cited region and use `sourceQuote` for the full text. Use hypothesis-driven debugging: each finding should identify a root cause and propose a fix.',
  verify_work: 'Your output MUST include a `findings[]` array (JSON, alongside any prose). Each finding has: `id` (string), `severity` (\'high\'|\'medium\'|\'low\'), `file` (string|null), `line` (number 1-indexed|null), `claim` (string), `sourceQuote?` (string), `suggestedFix?` (string). For project-level findings (no specific file), set `file` and `line` to null. For multi-line findings, point `line` at the start of the cited region and use `sourceQuote` for the full text. Map each checklist item to a finding: pass/fail with evidence linked to the relevant file and line.',
  audit_document: 'Your output MUST include a `findings[]` array (JSON, alongside any prose). Each finding has: `id` (string), `severity` (\'high\'|\'medium\'|\'low\'), `file` (string|null), `line` (number 1-indexed|null), `claim` (string), `sourceQuote?` (string), `suggestedFix?` (string). For project-level findings (no specific file), set `file` and `line` to null. For multi-line findings, point `line` at the start of the cited region and use `sourceQuote` for the full text. Each finding should describe an issue discovered in the document with its severity.',
  execute_plan: 'Implement the task fully. Report: which task heading you matched, what files were created or modified, and any issues encountered. If no unique matching task was found, report that explicitly and do not implement anything.',
  investigate_codebase: 'Your output MUST include a `findings[]` array (JSON, alongside any prose). Each finding has: `id` (string), `severity` (\'high\'|\'medium\'|\'low\'), `file` (string|null), `line` (number 1-indexed|null), `claim` (string), `sourceQuote?` (string), `suggestedFix?` (string). For project-level findings (no specific file), set `file` and `line` to null. For multi-line findings, point `line` at the start of the cited region and use `sourceQuote` for the full text. State your confidence level (`high`, `medium`, or `low`) for each finding and list any questions you could not resolve from the available evidence.',
};

export const ROUTE_DEFAULTS: Record<SourceRoute, Partial<TaskSpec>> = {
  delegate_tasks: {},
  review_code: { agentType: 'complex', reviewPolicy: 'quality_only' },
  debug_task: { agentType: 'complex', reviewPolicy: 'quality_only' },
  verify_work: { agentType: 'complex', reviewPolicy: 'quality_only' },
  audit_document: { agentType: 'complex', reviewPolicy: 'quality_only' },
  execute_plan: { agentType: 'standard', reviewPolicy: 'full' },
  investigate_codebase: { agentType: 'complex', reviewPolicy: 'quality_only' },
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
    tools: config.defaults?.tools ?? 'full',
    timeoutMs: config.defaults?.timeoutMs ?? 1_800_000,
    maxCostUSD: config.defaults?.maxCostUSD ?? 10,
    sandboxPolicy: config.defaults?.sandboxPolicy ?? 'cwd-only',
    briefQualityPolicy: 'off',
    cwd: process.cwd(),
    skipCompletionHeuristic: draft.skipCompletionHeuristic,
  };
}