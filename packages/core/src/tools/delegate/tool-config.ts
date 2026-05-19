import { ToolSurfaceRegistry } from '../../tool-surface/tool-surface-registry.js';
import { inputSchema } from './schema.js';
import type { Input } from './schema.js';
import type { ToolConfig } from '../../lifecycle/tool-config-types.js';
import { delegateHeadlineTemplate } from '../../reporting/headline-templates/delegate.js';
import { delegateReportSchema } from '../../reporting/report-parser-slots/delegate-report.js';
import { delegateBriefSlot, type DelegateBrief } from './brief-slot.js';
import { DEFAULT_TASK_TIMEOUT_MS } from '../../config/schema.js';

export function registerDelegate(registry: ToolSurfaceRegistry): void {
  registry.register({
    routeName: 'delegate',
    httpMethod: 'POST',
    httpPath: '/delegate',
    surface: 'tool',
    schema: inputSchema,
    toolCategory: 'artifact_producing',
    agentTypeDefault: 'standard',
    agentTypeOverridable: true,
    responseShapeName: 'BatchResponse',
  });
}

export const toolConfig: ToolConfig<Input, DelegateBrief, unknown> = {
  name: 'delegate',
  category: 'artifact_producing',
  serializeSameRepo: true,
  agentType: 'standard',
  briefSlot: delegateBriefSlot,
  buildTaskSpec: (brief, ctx) => ({
    prompt: brief.prompt,
    agentType: brief.agentType,
    reviewPolicy: brief.reviewPolicy,
    done: brief.done,
    filePaths: brief.filePaths,
    contextBlockIds: brief.contextBlockIds,
    cwd: ctx.projectContext?.cwd ?? ctx.cwd,
    tools: ctx.config.defaults?.tools ?? 'full',
    timeoutMs: ctx.config.defaults?.timeoutMs ?? DEFAULT_TASK_TIMEOUT_MS,
    sandboxPolicy: ctx.config.defaults?.sandboxPolicy ?? 'cwd-only',
  }),
  reportSchema: delegateReportSchema,
  headlineTemplate: delegateHeadlineTemplate,
};
