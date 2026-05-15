import { ToolSurfaceRegistry } from '../../tool-surface/tool-surface-registry.js';
import { inputSchema } from './schema.js';
import type { Input } from './schema.js';
import type { ToolConfig } from '../../lifecycle/tool-config-types.js';
import { delegateHeadlineTemplate } from '../../reporting/headline-templates/delegate.js';
import { delegateReportSchema } from '../../reporting/report-parser-slots/delegate-report.js';
import { compileDelegatePrompt } from '../../intake/brief-compiler-slots/delegate.js';
import type { ReviewPolicy } from '../../intake/brief-compiler-slots/delegate.js';
import { specLintTemplate } from '../../review/templates/spec-review.js';
import { qualityLintTemplate } from '../../review/templates/quality-review.js';
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

export interface DelegateBrief {
  prompt: string;
  done?: string;
  filePaths?: string[];
  agentType: 'standard' | 'complex';
  reviewPolicy: ReviewPolicy;
  contextBlockIds?: string[];
  verifyCommand?: string[];
  maxCostUSD?: number;
}

export const toolConfig: ToolConfig<Input, DelegateBrief, unknown> = {
  name: 'delegate',
  category: 'artifact_producing',
  agentType: 'standard',
  briefSlot: (input) =>
    input.tasks.map((t) => ({
      prompt: compileDelegatePrompt({ prompt: t.prompt }),
      done: t.done,
      filePaths: t.filePaths,
      agentType: t.agentType ?? 'standard',
      reviewPolicy: t.reviewPolicy ?? 'full',
      contextBlockIds: t.contextBlockIds,
      verifyCommand: t.verifyCommand,
      maxCostUSD: t.maxCostUSD,
    })),
  buildTaskSpec: (brief, ctx) => ({
    prompt: brief.prompt,
    agentType: brief.agentType,
    reviewPolicy: brief.reviewPolicy,
    done: brief.done,
    filePaths: brief.filePaths,
    contextBlockIds: brief.contextBlockIds,
    verifyCommand: brief.verifyCommand,
    maxCostUSD: brief.maxCostUSD,
    cwd: ctx.projectContext?.cwd ?? ctx.cwd,
    tools: ctx.config.defaults?.tools ?? 'full',
    timeoutMs: ctx.config.defaults?.timeoutMs ?? DEFAULT_TASK_TIMEOUT_MS,
    sandboxPolicy: ctx.config.defaults?.sandboxPolicy ?? 'cwd-only',
  }),
  reportSchema: delegateReportSchema,
  headlineTemplate: delegateHeadlineTemplate,
  reviewTemplates: {
    spec: specLintTemplate,
    qualityAP: qualityLintTemplate,
  },
};
