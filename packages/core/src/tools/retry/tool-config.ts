import { ToolSurfaceRegistry } from '../../tool-surface/tool-surface-registry.js';
import { inputSchema } from './schema.js';
import type { Input } from './schema.js';
import type { ToolConfig } from '../../lifecycle/tool-config-types.js';
import type { TaskSpec, RuntimeRunResult } from '../../types.js';
import { retryReportSchema } from '../../reporting/report-parser-slots/retry-report.js';
import { retryHeadlineTemplate } from '../../reporting/headline-templates/retry.js';
import { notApplicable } from '../../reporting/not-applicable.js';

export function registerRetry(registry: ToolSurfaceRegistry): void {
  registry.register({
    routeName: 'retry_tasks',
    httpMethod: 'POST',
    httpPath: '/retry',
    surface: 'tool',
    schema: inputSchema,
    toolCategory: 'assist',
    agentTypeDefault: 'standard',
    agentTypeOverridable: true,
    responseShapeName: 'BatchResponse',
  });
}

interface RetryBrief {
  batchId: string;
  taskIndex: number;
}

export const toolConfig: ToolConfig<Input, RetryBrief, unknown> = {
  name: 'retry',
  category: 'assist',
  agentType: 'standard',
  briefSlot: (input) =>
    input.taskIndices.map((idx) => ({ batchId: input.batchId, taskIndex: idx })),
  buildTaskSpec: (brief, ctx) => {
    const batchCache = ctx.projectContext?.batchCache;
    const batch = batchCache?.get(brief.batchId);
    const origTask = batch?.tasks[brief.taskIndex] as TaskSpec | undefined;
    const defaults = ctx.config.defaults;
    return {
      prompt: origTask?.prompt ?? `Retry task ${brief.taskIndex} from batch ${brief.batchId}`,
      agentType: origTask?.agentType ?? 'standard',
      reviewPolicy: origTask?.reviewPolicy ?? 'none',
      briefQualityPolicy: origTask?.briefQualityPolicy ?? 'off',
      tools: origTask?.tools ?? defaults?.tools ?? 'full',
      timeoutMs: origTask?.timeoutMs ?? defaults?.timeoutMs ?? 1_800_000,
      maxCostUSD: origTask?.maxCostUSD ?? defaults?.maxCostUSD ?? 10,
      sandboxPolicy: origTask?.sandboxPolicy ?? defaults?.sandboxPolicy ?? 'cwd-only',
      cwd: origTask?.cwd ?? ctx.projectContext?.cwd ?? ctx.cwd,
      contextBlockIds: origTask?.contextBlockIds ?? [],
      mainModel: origTask?.mainModel,
      done: origTask?.done,
      autoCommit: origTask?.autoCommit ?? false,
    };
  },
  reportSchema: retryReportSchema,
  headlineTemplate: retryHeadlineTemplate,
  postProcessEnvelope: (envelope, ctx) => {
    const results = (Array.isArray(envelope.results) ? envelope.results : []) as RuntimeRunResult[];
    const total = results.length;
    // Tool sweep #8 fix: pre-fix this hard-coded `retry: N/N tasks complete`
    // regardless of actual outcomes — operator could not tell if any
    // retried task had failed. Now compute the true ok/incomplete/error
    // breakdown from per-task `status` and emit a headline that mirrors
    // delegate / execute-plan: '[<aggregate-status>] retry: ok/total tasks complete'
    // with detail when not all ok.
    let ok = 0, incomplete = 0, error = 0;
    for (const r of results) {
      const s = r?.status;
      if (s === 'ok') ok++;
      else if (s === 'error') error++;
      else incomplete++; // 'incomplete' or any unknown bucket
    }
    const aggregate: 'ok' | 'incomplete' | 'error' =
      error > 0 ? 'error' : incomplete > 0 ? 'incomplete' : 'ok';
    let detail = `${ok}/${total} tasks complete`;
    if (incomplete > 0) detail += `, ${incomplete} incomplete`;
    if (error > 0) detail += `, ${error} error`;
    envelope.headline = `[${aggregate}] retry: ${detail}`;
    envelope.structuredReport = notApplicable('no structured report emitted by this executor');
    // Tool sweep #8: keep the underlying review verdicts on the envelope
    // (do NOT delete) so downstream telemetry + UI can show whether the
    // retried tasks' lifecycles passed their spec/quality chains. Pre-fix
    // these were stripped, hiding important failure signal.
    if (ctx?.batchId) {
      envelope.retryBatchId = ctx.batchId;
    }
    return envelope;
  },
};
