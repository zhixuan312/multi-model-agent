import { ToolSurfaceRegistry } from '../../tool-surface/tool-surface-registry.js';
import { inputSchema } from './schema.js';
import type { Input } from './schema.js';
import { ReviewerEngine } from '../../review/reviewer-engine.js';
import {
  ReviewerPromptBuilder,
  specTemplate,
  qualityAPTemplate,
  diffTemplate,
} from '../../review/reviewer-engine.js';
import type { ToolConfig } from '../../lifecycle/tool-config-types.js';

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

export function makeDelegateReviewer(): ReviewerEngine {
  const builder = new ReviewerPromptBuilder({ spec: specTemplate, qualityForAP: qualityAPTemplate, diff: diffTemplate });
  return new ReviewerEngine(builder);
}

export const toolConfig: ToolConfig<Input> = {
  name: 'delegate',
  category: 'artifact_producing',
  agentType: 'standard',
  briefSlot: (input) => input.tasks.map((t) => ({ prompt: t.prompt, done: t.done, filePaths: t.filePaths, reviewPolicy: t.reviewPolicy })),
  buildTaskSpec: (brief, ctx) => ({
    prompt: (brief as any).prompt ?? '',
    agentType: 'standard',
    reviewPolicy: (brief as any).reviewPolicy ?? 'full' as const,
    done: (brief as any).done,
    filePaths: (brief as any).filePaths,
    cwd: ctx.projectContext?.cwd ?? ctx.cwd,
    tools: ctx.config.defaults?.tools ?? 'full',
    timeoutMs: ctx.config.defaults?.timeoutMs,
    maxCostUSD: ctx.config.defaults?.maxCostUSD,
    sandboxPolicy: ctx.config.defaults?.sandboxPolicy ?? 'cwd-only',
  }),
  reportSchema: { parse: (text) => { try { return JSON.parse(text); } catch { return text; } } },
  headlineTemplate: { compose: ({ taskBrief, status }) => `${status}: ${taskBrief}` },
  reviewTemplates: {
    spec: specTemplate,
    qualityAP: qualityAPTemplate,
    diff: diffTemplate,
  },
};
