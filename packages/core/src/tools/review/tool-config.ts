import { ToolSurfaceRegistry } from '../../tool-surface/tool-surface-registry.js';
import { inputSchema } from './schema.js';
import type { Input } from './schema.js';
import { qualityReviewTemplate } from '../../review/reviewer-engine.js';
import type { ToolConfig } from '../../lifecycle/tool-config-types.js';

export function registerReview(registry: ToolSurfaceRegistry): void {
  registry.register({
    routeName: 'review',
    httpMethod: 'POST',
    httpPath: '/review',
    surface: 'tool',
    schema: inputSchema,
    toolCategory: 'read_only',
    agentTypeDefault: 'complex',
    agentTypeOverridable: false,
    responseShapeName: 'BatchResponse',
  });
}

export const toolConfig: ToolConfig<Input> = {
  name: 'review',
  category: 'read_only',
  agentType: 'complex',
  briefSlot: (input) => [{ code: input.code, focus: input.focus, filePaths: input.filePaths, contextBlockIds: input.contextBlockIds }],
  buildTaskSpec: (brief, ctx) => ({
    prompt: `Review this code:\n${(brief as any).code ?? ''}`,
    agentType: 'complex',
    reviewPolicy: 'quality_only' as const,
    done: (brief as any).focus ? `Focus areas: ${(brief as any).focus.join(', ')}.` : 'Review code for correctness, security, performance, and style.',
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
    qualityAP: qualityReviewTemplate,
  },
};
