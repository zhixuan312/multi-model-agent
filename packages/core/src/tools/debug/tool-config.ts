import { ToolSurfaceRegistry } from '../../tool-surface/tool-surface-registry.js';
import { inputSchema } from './schema.js';
import type { Input } from './schema.js';
import type { ToolConfig } from '../../lifecycle/tool-config-types.js';
import { debugBriefSlot, type ToolDebugBrief } from './brief-slot.js';
import { noStructuredReportSchema } from '../../reporting/report-parser-slots/no-structured-report.js';
import { makeFindingsHeadlineTemplate } from '../../reporting/findings-headline.js';
import { DEFAULT_TASK_TIMEOUT_MS } from '../../config/schema.js';

export function registerDebug(registry: ToolSurfaceRegistry): void {
  registry.register({
    routeName: 'debug',
    httpMethod: 'POST',
    httpPath: '/debug',
    surface: 'tool',
    schema: inputSchema,
    toolCategory: 'read_only',
    agentTypeDefault: 'complex',
    agentTypeOverridable: false,
    responseShapeName: 'BatchResponse',
  });
}

export const toolConfig: ToolConfig<Input, ToolDebugBrief, unknown> = {
  name: 'debug',
  category: 'read_only',
  dispatchMode: 'parallel',
  dispatchModeOverridable: false,
  agentType: 'complex',
  briefSlot: debugBriefSlot,
  buildTaskSpec: (brief, ctx) => {
    const targetParts: string[] = [`Problem to debug:\n\n${brief.problem}`];
    if (brief.context) targetParts.push(`Context: ${brief.context}`);
    if (brief.hypothesis) targetParts.push(`Initial hypothesis: ${brief.hypothesis}`);
    // The read-route dispatcher builds the worker prefix from this pure target
    // + FINDING_FORMAT_SHARED + debug RouteSemantics; `prompt` mirrors it
    // (required field / telemetry, not the read-route worker input).
    const target = targetParts.join('\n\n');
    return {
      prompt: target,
      readTarget: target,
      agentType: 'complex',
      reviewPolicy: 'none',
      briefQualityPolicy: 'off',
      done: 'Identify the root cause with evidence (file, line, mechanism) and PROPOSE a fix. Do NOT apply the fix — debug is a read-only diagnostic; the caller decides whether to apply.',
      tools: ctx.config.defaults?.tools ?? 'full',
      timeoutMs: ctx.config.defaults?.timeoutMs ?? DEFAULT_TASK_TIMEOUT_MS,
      sandboxPolicy: ctx.config.defaults?.sandboxPolicy ?? 'cwd-only',
      cwd: ctx.projectContext?.cwd ?? ctx.cwd,
      contextBlockIds: brief.contextBlockIds,
      filePaths: brief.filePaths && brief.filePaths.length > 0 ? brief.filePaths : undefined,
      mainModel: ctx.mainModel ?? undefined,
    };
  },
  reportSchema: noStructuredReportSchema,
  headlineTemplate: makeFindingsHeadlineTemplate('debug', 'high'),
};
