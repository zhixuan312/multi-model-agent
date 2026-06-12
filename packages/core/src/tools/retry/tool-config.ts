import { ToolSurfaceRegistry } from '../../tool-surface/tool-surface-registry.js';
import { inputSchema } from './schema.js';
import type { Input } from './schema.js';
import { retryBriefSlot, type RetryBrief } from './brief-slot.js';
import type { ToolConfig } from '../../lifecycle/tool-config-types.js';
import type { TaskSpec, RuntimeRunResult } from '../../types.js';
import { noStructuredReportSchema } from '../../reporting/report-parser-slots/no-structured-report.js';
import { makeFindingsHeadlineTemplate } from '../../reporting/findings-headline.js';
import { notApplicable } from '../../reporting/not-applicable.js';
import { implementGoalPrompt } from '../../lifecycle/goal-prompts.js';

const RETRY_PREAMBLE = [
  'RETRY: the plan below was partially executed in a prior run. The commits since the run',
  'start (see `git log`) show what is already done. Do NOT redo committed, correct work —',
  'complete what is missing and fix what is wrong, committing with the same `[task N]` convention.',
  '',
].join('\n');

/** Thrown when the prior batch's goal has been evicted from the cache. */
class GoalNotFoundError extends Error {
  readonly code = 'goal_not_found';
  constructor(batchId: string) { super(`no stored goal for batch ${batchId}`); this.name = 'GoalNotFoundError'; }
}

export function registerRetry(registry: ToolSurfaceRegistry): void {
  registry.register({
    routeName: 'retry_tasks',
    httpMethod: 'POST',
    httpPath: '/retry',
    surface: 'tool',
    schema: inputSchema,
    toolCategory: 'assist',
    agentTypeDefault: 'standard',
    agentTypeOverridable: false,
    responseShapeName: 'BatchResponse',
  });
}

export const toolConfig: ToolConfig<Input, RetryBrief, unknown> = {
  name: 'retry',
  category: 'assist',
  dispatchMode: 'serial',
  dispatchModeOverridable: false,
  agentType: 'standard',
  briefSlot: retryBriefSlot,
  buildTaskSpec: (brief, ctx) => {
    const batch = ctx.projectContext?.batchCache?.get(brief.batchId);
    const origTask = batch?.tasks[0] as TaskSpec | undefined;
    if (!origTask?.goal) throw new GoalNotFoundError(brief.batchId);
    // Re-fire the same goal-set; the prepare stage captures a fresh baseSha
    // (current HEAD) so the re-run continues from where the prior run left off.
    return {
      ...origTask,
      prompt: RETRY_PREAMBLE + implementGoalPrompt(origTask.goal),
    };
  },
  reportSchema: noStructuredReportSchema,
  headlineTemplate: makeFindingsHeadlineTemplate('retry', 'high'),
  postProcessEnvelope: (envelope, ctx) => {
    const results = (Array.isArray(envelope.results) ? envelope.results : []) as RuntimeRunResult[];
    const total = results.length;
    let ok = 0, incomplete = 0, error = 0;
    for (const r of results) {
      const s = r?.status;
      if (s === 'ok') ok++;
      else if (s === 'error') error++;
      else incomplete++;
    }
    const aggregate: 'ok' | 'incomplete' | 'error' =
      error > 0 ? 'error' : incomplete > 0 ? 'incomplete' : 'ok';
    let detail = `${ok}/${total} tasks complete`;
    if (incomplete > 0) detail += `, ${incomplete} incomplete`;
    if (error > 0) detail += `, ${error} error`;
    envelope.headline = `[${aggregate}] retry: ${detail}`;
    envelope.structuredReport = notApplicable('no structured report emitted by this executor');
    if (ctx?.batchId) {
      envelope.retryBatchId = ctx.batchId;
    }
    return envelope;
  },
};
