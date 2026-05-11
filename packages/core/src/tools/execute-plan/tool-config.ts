import { z } from 'zod';
import { ToolSurfaceRegistry } from '../../tool-surface/tool-surface-registry.js';
import {
  specLintTemplate,
  qualityLintTemplate,
} from '../../review/reviewer-engine.js';
import type { ToolConfig } from '../../lifecycle/tool-config-types.js';
import { toolExecutePlanBriefSlot, type ToolExecutePlanBrief } from '../../intake/brief-compiler-slots/execute-plan.js';
import { executePlanHeadlineTemplate } from '../../reporting/headline-templates/execute-plan.js';
import { executePlanReportSchema } from '../../reporting/report-parser-slots/execute-plan-report.js';
import { DEFAULT_TASK_TIMEOUT_MS } from '../../config/schema.js';
import {
  EXECUTE_PLAN_PURPOSE_ORIENTATION,
  EXECUTE_PLAN_SCOPE_RULE,
  EXECUTE_PLAN_FAILURE_MODES,
  PLAN_VS_SOURCE_RECONCILIATION,
  SELF_VERIFICATION,
  TURN_BUDGET,
} from './implementer-criteria.js';

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
 *
 * The prompt is structured top-down: orientation (why this exists) →
 * task descriptor → matched plan section → file paths → fidelity rules
 * (RESTORED in 4.1.0; the older `compileExecutePlan` had them, the
 * slot-style refactor that became the canonical path dropped them) →
 * failure-mode taxonomy → reviewer awareness. Without the orientation
 * + fidelity blocks, workers default to "implement the goal" and treat
 * the plan as a starting suggestion rather than the contract.
 */
function buildExecutePlanPrompt(
  filePaths: string[],
  task: string,
  taskSection: string | undefined,
  sectionTruncated: boolean,
): string {
  const parts: string[] = [
    // Orientation goes FIRST — fidelity-first framing before the
    // task descriptor, so the worker reads the section through the
    // execution lens instead of the "improve it" lens.
    EXECUTE_PLAN_PURPOSE_ORIENTATION,
    '',
    `Execute this task from the plan: "${task}"`,
    '',
  ];
  if (taskSection) {
    const sectionBytes = Buffer.byteLength(taskSection, 'utf8');
    parts.push('Relevant plan section:', '', '---', taskSection.trim(), '---', '');
    if (sectionTruncated) {
      parts.push(
        `⚠ Section TRUNCATED — visible above is the first ~${sectionBytes} bytes; the tail was cut at the size cap. The visible portion is correct up to the cut. If you need the missing tail, read the full plan file (path below). If the visible portion is sufficient to execute the task, proceed.`,
        '',
      );
    } else {
      parts.push(
        `✓ Section is COMPLETE (${sectionBytes} bytes, heading-to-heading). No truncation. If you find yourself thinking "this section looks truncated" or "this seems to end mid-step", you are misreading the boundary — re-read carefully before bailing. The most common misread: a closing \`\`\` code-fence near the section boundary looks like a mid-stream cut. It is not.`,
        '',
      );
    }
  } else {
    parts.push(
      'No unique plan section matched that task heading. The full plan file is at:',
      ...filePaths.map((p) => `  - ${p}`),
      'Read the plan file(s) yourself to find the task. If still no unique match, report that and stop — do not implement anything.',
      '',
    );
  }
  // Only mention "plan files for reference" when section is missing or
  // truncated — when the section is complete, the worker should rely on
  // it as authoritative. Telling the worker to "re-read for adjacent
  // context" when not needed encourages second-guessing and fails when
  // the plan path is outside cwd (sandbox blocks the read).
  if (!taskSection || sectionTruncated) {
    parts.push(
      'Plan files for reference (read on demand if you need adjacent context — but do not enlarge scope into other tasks):',
      ...filePaths.map((p) => `  - ${p}`),
      '',
    );
  }
  parts.push(
    'Implement the task fully. Follow acceptance criteria, file paths, and',
    'constraints in the plan section above.',
    '',
    EXECUTE_PLAN_SCOPE_RULE,
    '',
    EXECUTE_PLAN_FAILURE_MODES,
    '',
    PLAN_VS_SOURCE_RECONCILIATION,
    '',
    SELF_VERIFICATION,
    '',
    TURN_BUDGET,
  );
  return parts.join('\n');
}

export const toolConfig: ToolConfig<ExecutePlanWireInput, ToolExecutePlanBrief> = {
  name: 'execute_plan',
  category: 'artifact_producing',
  agentType: 'standard',
  briefSlot: toolExecutePlanBriefSlot,
  buildTaskSpec: (brief, ctx) => ({
    prompt: buildExecutePlanPrompt(brief.filePaths, brief.taskDescriptor, brief.sectionBody, brief.sectionTruncated),
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
    spec: specLintTemplate,
    qualityAP: qualityLintTemplate,
    diff: specLintTemplate,  // diff path retained for type-shape only; not used post-redesign
  },
};
