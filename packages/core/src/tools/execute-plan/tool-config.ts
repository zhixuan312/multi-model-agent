import { z } from 'zod';
import { ToolSurfaceRegistry } from '../../tool-surface/tool-surface-registry.js';
import {
  specTemplate,
  qualityAPTemplate,
  diffTemplate,
} from '../../review/reviewer-engine.js';
import type { ToolConfig } from '../../lifecycle/tool-config-types.js';
import { toolExecutePlanBriefSlot, type ToolExecutePlanBrief } from '../../intake/brief-compiler-slots/execute-plan.js';
import { executePlanHeadlineTemplate } from '../../reporting/headline-templates/execute-plan.js';
import { executePlanReportSchema } from '../../reporting/report-parser-slots/execute-plan-report.js';
import { DEFAULT_TASK_TIMEOUT_MS } from '../../config/schema.js';
import { REVIEWER_AWARENESS_AP } from '../../review/templates/finding-criteria.js';

export const executePlanInputSchema = z.object({
  filePaths: z.array(z.string()).length(1, { message: "execute_plan requires exactly one plan filePath" }),
  taskDescriptors: z.array(z.string()).min(1),
  cwd: z.string().optional(),
  perTaskReviewPolicy: z.record(z.string(), z.enum(['full', 'quality_only', 'diff_only', 'none'])).optional(),
  contextBlockIds: z.array(z.string()).optional(),
  verifyCommand: z.array(z.string()).optional(),
}).strict();

export type ExecutePlanWireInput = z.infer<typeof executePlanInputSchema>;

export function registerExecutePlan(registry: ToolSurfaceRegistry): void {
  registry.register({
    routeName: 'execute_plan',
    httpMethod: 'POST',
    httpPath: '/execute-plan',
    surface: 'tool',
    schema: executePlanInputSchema,
    toolCategory: 'artifact_producing',
    agentTypeDefault: 'standard',
    agentTypeOverridable: false,
    responseShapeName: 'BatchResponse',
  });
}

/**
 * Build a compact worker prompt for one plan task. Extracted from the legacy
 * executor — just the section matched by the slot, not the full plan file.
 */
function buildExecutePlanPrompt(
  filePaths: string[],
  task: string,
  taskSection: string | undefined,
): string {
  const parts: string[] = [
    `Execute this task from the plan: "${task}"`,
    '',
  ];
  if (taskSection) {
    parts.push('Relevant plan section:', '', '---', taskSection.trim(), '---', '');
  } else {
    parts.push(
      'No unique plan section matched that task heading. The full plan file is at:',
      ...filePaths.map((p) => `  - ${p}`),
      'Read the plan file(s) yourself to find the task.',
      '',
    );
  }
  parts.push(
    'Plan files for reference (read on demand if you need adjacent context):',
    ...filePaths.map((p) => `  - ${p}`),
    '',
  );
  parts.push(
    'Implement the task fully. Follow any acceptance criteria, file paths, and',
    'constraints in the plan section above. If you cannot find or understand',
    'the task, report that explicitly and do not implement anything.',
    '',
    // Tool sweep #12: share spec + quality reviewer rubric so the
    // worker self-aligns on what each reviewer will judge against.
    REVIEWER_AWARENESS_AP,
  );
  return parts.join('\n');
}

export const toolConfig: ToolConfig<ExecutePlanWireInput, ToolExecutePlanBrief> = {
  name: 'execute_plan',
  category: 'artifact_producing',
  agentType: 'standard',
  briefSlot: toolExecutePlanBriefSlot,
  buildTaskSpec: (brief, ctx) => ({
    prompt: buildExecutePlanPrompt(brief.filePaths, brief.taskDescriptor, brief.sectionBody),
    agentType: 'standard',
    reviewPolicy: brief.reviewPolicy,
    done: 'Implement the task fully. Report: which task heading you matched, what files were created or modified, and any issues encountered. If no unique matching task was found, report that explicitly and do not implement anything.',
    tools: ctx.config.defaults?.tools ?? 'full',
    timeoutMs: ctx.config.defaults?.timeoutMs ?? DEFAULT_TASK_TIMEOUT_MS,
    maxCostUSD: ctx.config.defaults?.maxCostUSD ?? 10,
    sandboxPolicy: ctx.config.defaults?.sandboxPolicy ?? 'cwd-only',
    cwd: brief.cwd,
    filePaths: brief.filePaths,
    contextBlockIds: brief.contextBlockIds,
    autoCommit: true,
    verifyCommand: brief.verifyCommand,
    ...(brief.sectionBody ? { planContext: brief.sectionBody } : {}),
  }),
  reportSchema: executePlanReportSchema,
  headlineTemplate: executePlanHeadlineTemplate,
  reviewTemplates: {
    spec: specTemplate,
    qualityAP: qualityAPTemplate,
    diff: diffTemplate,
  },
};
