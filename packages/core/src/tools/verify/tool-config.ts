import { ToolSurfaceRegistry } from '../../tool-surface/tool-surface-registry.js';
import { inputSchema } from './schema.js';
import type { Input } from './schema.js';
import { qualityVerifyTemplate } from '../../review/reviewer-engine.js';
import type { ToolConfig } from '../../lifecycle/tool-config-types.js';
import type { ExecutionContext } from '../../lifecycle/lifecycle-context.js';
import { verifyReportSchema } from '../../reporting/report-parser-slots/verify-report.js';
import { verifyHeadlineTemplate } from '../../reporting/headline-templates/verify.js';
import { DEFAULT_TASK_TIMEOUT_MS } from '../../config/schema.js';
import {
  SEVERITY_LADDER,
  EVIDENCE_GROUNDING,
  SCOPE_DISCIPLINE,
  ANNOTATOR_CHECK_AWARENESS_RO,
} from '../../review/templates/finding-criteria.js';

export function registerVerify(registry: ToolSurfaceRegistry): void {
  registry.register({
    routeName: 'verify',
    httpMethod: 'POST',
    httpPath: '/verify',
    surface: 'tool',
    schema: inputSchema,
    toolCategory: 'read_only',
    agentTypeDefault: 'complex',
    agentTypeOverridable: false,
    responseShapeName: 'BatchResponse',
  });
}

// ── Brief ──

export interface VerifyBrief {
  work?: string;
  filePaths: string[];
  checklist: string[];
  contextBlockIds: string[];
  /** For fan_out mode, the base prompt template without per-file header. */
  promptTemplate?: string;
}

// ── Prompt builders (lifted from legacy executor) ──

const FINDING_FORMAT_INSTRUCTIONS = [
  'For each checklist item, use this EXACT per-finding format — both the structured reviewer and the deterministic fallback extract from this same format:',
  '',
  '## Finding 1: <one-line title (the criterion summary)>',
  '- Severity: low for PASS, medium or high for FAIL (depending on impact)',
  '- Item: the criterion text',
  '- Result: PASS or FAIL',
  '- Evidence: file:line + what it shows, OR command + output',
  '',
  '## Finding 2: <one-line title>',
  '- Severity: ...',
  '- ...',
  '',
  'Rules:',
  '- One `## Finding N:` block per checklist item — same count and same order as the checklist. Do not skip items even if they pass trivially.',
  '- Severity / Item / Result / Evidence bullets are on their own lines with the labels exactly as shown.',
  '',
  // Tool sweep #12: shared rubric so worker calibrates the same way the
  // annotator validates. For verify, severity is bound to the result —
  // the SEVERITY_LADDER below explains the ladder; here we just bind:
  // PASS -> low, FAIL -> medium/high based on impact.
  SEVERITY_LADDER,
  '',
  EVIDENCE_GROUNDING,
  '',
  SCOPE_DISCIPLINE,
  '',
  ANNOTATOR_CHECK_AWARENESS_RO,
].join('\n');

function buildFilePathsPrompt(filePaths?: string[]): string {
  if (!filePaths || filePaths.length === 0) return '';
  return `Read and analyze these files:\n${filePaths.map(p => `- ${p}`).join('\n')}`;
}

function buildVerifyPrompt(
  work: string | undefined,
  filePaths: string[] | undefined,
  checklist: string[],
): string {
  const parts: string[] = ['Verify this work:'];
  if (work) parts.push(work);
  const fileSection = buildFilePathsPrompt(filePaths);
  if (fileSection) parts.push(fileSection);
  const checklistText = checklist.map((item, i) => `${i + 1}. ${item}`).join('\n');
  parts.push(`Checklist:\n${checklistText}`);
  parts.push(FINDING_FORMAT_INSTRUCTIONS);
  return parts.join('\n\n');
}

function buildPerFilePrompt(filePath: string, promptTemplate: string): string {
  return `${promptTemplate}\n\nRead and analyze this file:\n- ${filePath}`;
}

function hasContent(value: string | undefined): boolean {
  return value !== undefined && value.trim().length > 0;
}

// ── ToolConfig ──

export const toolConfig: ToolConfig<Input, VerifyBrief, unknown> = {
  name: 'verify',
  category: 'read_only',
  agentType: 'complex',
  briefSlot: (input: Input): VerifyBrief[] => {
    const filePaths = (input.filePaths ?? []).filter(p => p.trim().length > 0);

    if (!hasContent(input.work) && filePaths.length >= 2) {
      // Fan-out: one task per file, shared prompt template
      const promptTemplate = buildVerifyPrompt(undefined, undefined, input.checklist);
      return filePaths.map(fp => ({
        work: input.work,
        filePaths: [fp],
        checklist: input.checklist,
        contextBlockIds: input.contextBlockIds ?? [],
        promptTemplate,
      }));
    }

    // Single task
    return [{
      work: input.work,
      filePaths,
      checklist: input.checklist,
      contextBlockIds: input.contextBlockIds ?? [],
    }];
  },
  buildTaskSpec: (brief: VerifyBrief, ctx: ExecutionContext) => {
    const prompt = brief.promptTemplate
      ? buildPerFilePrompt(brief.filePaths[0]!, brief.promptTemplate)
      : buildVerifyPrompt(brief.work, brief.filePaths.length > 0 ? brief.filePaths : undefined, brief.checklist);

    return {
      prompt,
      agentType: 'complex',
      reviewPolicy: 'quality_only',
      briefQualityPolicy: 'off',
      done: `Every checklist item (${brief.checklist.length} total) has a pass/fail verdict with supporting evidence from the code.`,
      tools: ctx.config.defaults?.tools ?? 'full',
      timeoutMs: ctx.config.defaults?.timeoutMs ?? DEFAULT_TASK_TIMEOUT_MS,
      maxCostUSD: ctx.config.defaults?.maxCostUSD ?? 10,
      sandboxPolicy: ctx.config.defaults?.sandboxPolicy ?? 'cwd-only',
      cwd: ctx.projectContext?.cwd ?? ctx.cwd,
      contextBlockIds: brief.contextBlockIds,
      filePaths: brief.filePaths.length > 0 ? brief.filePaths : undefined,
      mainModel: ctx.mainModel ?? undefined,
    };
  },
  reportSchema: verifyReportSchema,
  headlineTemplate: verifyHeadlineTemplate,
  reviewTemplates: {
    qualityAP: qualityVerifyTemplate,
  },
};
