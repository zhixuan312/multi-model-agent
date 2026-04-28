import type { TaskSpec } from '../types.js';
import type { MultiModelConfig } from '../types.js';
import type { DraftTask, SourceRoute } from './types.js';

// 3.8.1 worker contract: each finding object has fields {id, severity, claim, evidence, suggestion?}.
// `evidence` is REQUIRED and must be ≥20 chars — embed file:line as prose plus a
// one-sentence explanation of what the cited code shows. Reviewer-emitted fields
// (reviewerConfidence, reviewerSeverity) are added in the annotation pass; the
// worker MUST NOT include them.
const FINDINGS_BASE = [
  'Your output MUST include a single ```json fenced code block containing a `findings[]` array.',
  'Each finding object has these fields:',
  '- `id` (string, unique within the array)',
  '- `severity` (\'high\' | \'medium\' | \'low\')',
  '- `claim` (string, what is wrong / what is true)',
  '- `evidence` (string, REQUIRED, at least 20 characters): embed `file:line` as prose plus a one-sentence explanation of what the cited code or text actually shows. For project-level findings, describe what was searched/checked instead.',
  '- `suggestion?` (string, optional): a fix, follow-up step, or recommendation',
].join('\n');

export const OUTPUT_CONTRACT_CLAUSES: Partial<Record<SourceRoute, string>> = {
  review_code: `${FINDINGS_BASE}\nEach finding should describe a code-level concern (correctness, security, performance, style as applicable to the focus). Embed the file:line in evidence; the reader will jump to the source from your prose.`,
  debug_task: `${FINDINGS_BASE}\nUse hypothesis-driven debugging: each finding should identify a root cause and propose a fix in \`suggestion\`. Evidence should quote the relevant trace, log line, or code path.`,
  verify_work: `${FINDINGS_BASE}\nMap each checklist item from the brief to a finding: pass (low severity, evidence shows the criterion was met) or fail (high/medium severity, evidence shows what is missing). One finding per checklist item.`,
  audit_document: `${FINDINGS_BASE}\nEach finding should describe an issue discovered in the audited document. Severity reflects impact if the issue stands.`,
  execute_plan: 'Implement the task fully. Report: which task heading you matched, what files were created or modified, and any issues encountered. If no unique matching task was found, report that explicitly and do not implement anything.',
  investigate_codebase: `${FINDINGS_BASE}\nFor an investigation, \`suggestion\` is optional and may be a follow-up question or angle to explore rather than a code fix. Evidence may be a file:line citation or a description of what was searched (e.g., "Searched src/middleware/, src/auth/ — no auth middleware found").`,
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