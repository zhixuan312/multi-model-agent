import { ToolSurfaceRegistry } from '../../tool-surface/tool-surface-registry.js';
import { inputSchema } from './schema.js';
import type { Input } from './schema.js';
import type { ToolConfig } from '../../lifecycle/tool-config-types.js';
import type { TaskSpec } from '../../types.js';
import { retryReportSchema } from '../../reporting/report-parser-slots/retry-report.js';
import { retryHeadlineTemplate } from '../../reporting/headline-templates/retry.js';

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
      mainModel: origTask?.mainModel ?? defaults?.mainModel ?? undefined,
      done: origTask?.done,
      autoCommit: origTask?.autoCommit ?? false,
    };
  },
  reportSchema: retryReportSchema,
  headlineTemplate: retryHeadlineTemplate,
};
