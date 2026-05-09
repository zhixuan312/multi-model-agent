import { ToolSurfaceRegistry } from '../../tool-surface/tool-surface-registry.js';
import { inputSchema } from './schema.js';
import type { Input } from './schema.js';
import { qualityReviewTemplate } from '../../review/templates/quality-review-review.js';
import type { ToolConfig } from '../../lifecycle/tool-config-types.js';
import type { ExecutionContext } from '../../lifecycle/lifecycle-context.js';
import { reviewBriefSlot, type ReviewBrief } from '../../intake/brief-compiler-slots/review.js';
import { reviewReportSchema } from '../../reporting/report-parser-slots/review-report.js';
import { reviewHeadlineTemplate } from '../../reporting/headline-templates/review.js';
import { DEFAULT_TASK_TIMEOUT_MS } from '../../config/schema.js';
import { SEVERITY_LADDER } from '../../review/templates/finding-criteria.js';
import {
  EVIDENCE_RULE_REVIEW,
  SCOPE_RULE_REVIEW,
  ANNOTATOR_AWARENESS_REVIEW,
} from './implementer-criteria.js';

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

const REVIEW_DONE_CONDITIONS: Record<string, string> = {
  security: 'Identify security vulnerabilities with severity, location, and remediation.',
  performance: 'Identify performance issues with impact level, location, and fix recommendation.',
  correctness: 'Identify logic errors, edge cases, and contract violations with severity and location.',
  style: 'Identify style issues, naming inconsistencies, and dead code with location and fix.',
};

const DELTA_REVIEW_SUFFIX = ' Perform a full review (do not reduce thoroughness). Verify each prior finding as addressed or unaddressed. Omit addressed prior findings. Include unaddressed prior findings and new findings. End with a summary of which prior findings were resolved.';

function resolveReviewDoneCondition(focus: string[] | undefined, hasContextBlocks: boolean): string {
  if (!focus || focus.length === 0) {
    return `Review code for correctness, security, performance, and style. Each finding has category, severity, location, and recommendation.${hasContextBlocks ? DELTA_REVIEW_SUFFIX : ''}`;
  }
  const base = focus.map(f => REVIEW_DONE_CONDITIONS[f] ?? '').filter(Boolean).join(' ');
  return hasContextBlocks ? base + DELTA_REVIEW_SUFFIX : base;
}

function buildReviewPrompt(brief: ReviewBrief): string {
  const { code, filePaths, focus, hasContextBlocks, filePath } = brief;
  const parts: string[] = ['Review this code:'];

  if (filePath) {
    parts.push(`Read and analyze this file:\n- ${filePath}`);
  } else {
    if (code) parts.push(`\`\`\`\n${code}\n\`\`\``);
    if (filePaths && filePaths.length > 0) {
      parts.push(`Read and analyze these files:\n${filePaths.map(p => `- ${p}`).join('\n')}`);
    }
    if (focus && focus.length > 0) parts.push(`Focus areas: ${focus.join(', ')}.`);
  }

  // Tool sweep #11: emit format spec unconditionally (pre-fix the
  // DELTA branch dropped it, breaking annotator parse on delta runs).
  if (hasContextBlocks) {
    parts.push(
      'A prior review is in the context above. **Omit** addressed findings, **include** still-present ones (mark "unfixed from prior review"), **include** any new findings, and end with a **Fixed** summary.',
    );
  }
  parts.push(FINDING_FORMAT_INSTRUCTIONS);

  return parts.join('\n\n');
}

const FINDING_FORMAT_INSTRUCTIONS = [
  'Produce a narrative code review. Use this EXACT per-finding format — both the structured reviewer and the deterministic fallback extract from this same format:',
  '',
  '## Finding 1: <one-line title>',
  '- Severity: critical | high | medium | low',
  '- Location: file:line',
  '- Issue: one-paragraph explanation',
  '- Suggestion: one-line fix recommendation',
  '',
  '## Finding 2: <one-line title>',
  '- Severity: ...',
  '- ...',
  '',
  'Rules:',
  '- Each finding heading MUST start with "## Finding N: " (h2, "Finding ", number, colon, title) — number sequentially from 1.',
  '- Severity / Location / Issue / Suggestion bullets are on their own lines with the labels exactly as shown.',
  '- If you found no issues, say "No findings." in plain prose and emit zero `## Finding N:` blocks.',
  '',
  SEVERITY_LADDER,
  '',
  EVIDENCE_RULE_REVIEW,
  '',
  SCOPE_RULE_REVIEW,
  '',
  ANNOTATOR_AWARENESS_REVIEW,
].join('\n');

export const toolConfig: ToolConfig<Input, ReviewBrief, unknown> = {
  name: 'review',
  category: 'read_only',
  agentType: 'complex',
  briefSlot: reviewBriefSlot,
  buildTaskSpec: (brief, ctx) => {
    const prompt = buildReviewPrompt(brief);
    // Propagate filePaths + mainModel onto the TaskSpec so the headline
    // composer can name the file in clean-review headlines and so the
    // wire telemetry carries main_model attribution. Audit does this
    // already; review missed it, producing "[ok] review completed"
    // (no path) even when filePaths was provided. (Tool sweep #2 — gap surfaced
    // by review batch c24353f6 on packages/core/src/reporting/severity.ts.)
    const filePaths = brief.filePath
      ? [brief.filePath]
      : (brief.filePaths && brief.filePaths.length > 0 ? brief.filePaths : undefined);
    return {
      prompt,
      agentType: 'complex',
      reviewPolicy: 'quality_only',
      briefQualityPolicy: 'off',
      done: resolveReviewDoneCondition(brief.focus, brief.hasContextBlocks),
      tools: ctx.config.defaults?.tools ?? 'full',
      timeoutMs: ctx.config.defaults?.timeoutMs ?? DEFAULT_TASK_TIMEOUT_MS,
      maxCostUSD: ctx.config.defaults?.maxCostUSD ?? 10,
      sandboxPolicy: ctx.config.defaults?.sandboxPolicy ?? 'cwd-only',
      cwd: ctx.projectContext?.cwd ?? ctx.cwd,
      contextBlockIds: brief.contextBlockIds,
      filePaths,
      mainModel: ctx.mainModel ?? undefined,
      autoCommit: false,
    };
  },
  reportSchema: reviewReportSchema,
  headlineTemplate: reviewHeadlineTemplate,
  reviewTemplates: {
    qualityAP: qualityReviewTemplate,
  },
};
