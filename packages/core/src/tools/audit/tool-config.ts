import { ToolSurfaceRegistry } from '../../tool-surface/tool-surface-registry.js';
import { inputSchema, type Input } from './schema.js';
import { auditBriefSlot, type AuditBrief } from './brief-slot.js';
import { noStructuredReportSchema } from '../../reporting/report-parser-slots/no-structured-report.js';
import { makeFindingsHeadlineTemplate } from '../../reporting/findings-headline.js';
import type { ToolConfig } from '../../lifecycle/tool-config-types.js';
import type { TaskSpec } from '../../types.js';
import { DEFAULT_TASK_TIMEOUT_MS } from '../../config/schema.js';

export function registerAudit(registry: ToolSurfaceRegistry): void {
  registry.register({
    routeName: 'audit',
    httpMethod: 'POST',
    httpPath: '/audit',
    surface: 'tool',
    schema: inputSchema,
    toolCategory: 'read_only',
    agentTypeDefault: 'complex',
    agentTypeOverridable: false,
    responseShapeName: 'BatchResponse',
  });
}

export const toolConfig: ToolConfig<Input, AuditBrief, unknown> = {
  name: 'audit',
  category: 'read_only',
  agentType: 'complex',
  briefSlot: auditBriefSlot,
  buildTaskSpec: (brief, ctx) => {
    // The read-route dispatcher builds the worker prefix from this pure
    // target + FINDING_FORMAT_SHARED + the audit RouteSemantics (subtypes.ts);
    // `prompt` carries the same pure target (TaskSpec.prompt is required and
    // feeds telemetry, but is not the read-route worker input).
    const targetParts: string[] = [`Audit for ${brief.subtypeText} issues.`];
    if (brief.document) targetParts.push(`Document:\n\n${brief.document}`);
    if (brief.filePaths.length > 0) {
      targetParts.push(`Target files:\n${brief.filePaths.map(p => `- ${p}`).join('\n')}`);
    }
    const target = targetParts.join('\n\n');
    return {
      prompt: target,
      parallelTarget: target,
      agentType: 'complex',
      reviewPolicy: 'none',
      briefQualityPolicy: 'off',
      done: brief.done,
      tools: ctx.config.defaults?.tools ?? 'full',
      timeoutMs: ctx.config.defaults?.timeoutMs ?? DEFAULT_TASK_TIMEOUT_MS,
      sandboxPolicy: ctx.config.defaults?.sandboxPolicy ?? 'cwd-only',
      cwd: ctx.projectContext?.cwd ?? ctx.cwd,
      contextBlockIds: brief.contextBlockIds,
      filePaths: brief.filePaths.length > 0 ? brief.filePaths : undefined,
      mainModel: ctx.mainModel,
      // v4.4.x: plumb subtype to the dispatcher. The parallel-criteria
      // router reads `task.subtype` and looks it up in AUDIT_SUBTYPES.
      subtype: brief.subtype,
    } as TaskSpec;
  },
  reportSchema: noStructuredReportSchema,
  headlineTemplate: makeFindingsHeadlineTemplate('audit', 'high'),
};
