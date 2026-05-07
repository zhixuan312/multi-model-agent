import { ToolSurfaceRegistry } from '../../tool-surface/tool-surface-registry.js';
import { inputSchema } from './schema.js';
import type { Input } from './schema.js';
import { qualityAuditTemplate } from '../../review/reviewer-engine.js';
import type { ToolConfig } from '../../lifecycle/tool-config-types.js';

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

export const toolConfig: ToolConfig<Input> = {
  name: 'audit',
  category: 'read_only',
  agentType: 'complex',
  briefSlot: (input) => [{ document: input.document, auditType: input.auditType, filePaths: input.filePaths, contextBlockIds: input.contextBlockIds }],
  buildTaskSpec: (brief, ctx) => ({
    prompt: `Audit for ${(brief as any).auditType ?? 'issues'}:\n${(brief as any).document ?? ''}`,
    agentType: 'complex',
    reviewPolicy: 'quality_only' as const,
    cwd: ctx.projectContext?.cwd ?? ctx.cwd,
    contextBlockIds: (brief as any).contextBlockIds,
    filePaths: (brief as any).filePaths,
    tools: ctx.config.defaults?.tools ?? 'full',
    timeoutMs: ctx.config.defaults?.timeoutMs,
    maxCostUSD: ctx.config.defaults?.maxCostUSD,
    sandboxPolicy: ctx.config.defaults?.sandboxPolicy ?? 'cwd-only',
  }),
  reportSchema: { parse: (text) => { try { return JSON.parse(text); } catch { return text; } } },
  headlineTemplate: { compose: ({ taskBrief, status }) => `${status}: ${taskBrief}` },
  reviewTemplates: {
    qualityAP: qualityAuditTemplate,
  },
};
