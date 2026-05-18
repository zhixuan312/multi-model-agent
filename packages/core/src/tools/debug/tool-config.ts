import { ToolSurfaceRegistry } from '../../tool-surface/tool-surface-registry.js';
import { inputSchema } from './schema.js';
import type { Input } from './schema.js';
import { qualityDebugTemplate } from '../../review/templates/quality-review-debug.js';
import type { ToolConfig } from '../../lifecycle/tool-config-types.js';
import type { ExecutionContext } from '../../lifecycle/lifecycle-context.js';
import { debugBriefSlot, type ToolDebugBrief } from './brief-slot.js';
import { debugHeadlineTemplate } from '../../reporting/headline-templates/debug.js';
import { DEFAULT_TASK_TIMEOUT_MS } from '../../config/schema.js';
import { SEVERITY_LADDER } from '../../review/templates/finding-criteria.js';
import {
  DEBUG_PURPOSE_ORIENTATION,
  EVIDENCE_RULE_DEBUG,
  SCOPE_RULE_DEBUG,
  ANNOTATOR_AWARENESS_DEBUG,
  DEBUG_FAILURE_MODES,
  THOROUGHNESS_REMINDER_DEBUG,
} from './implementer-criteria.js';

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

const FINDING_FORMAT_INSTRUCTIONS = [
  // Orientation goes FIRST — the worker needs to know why this debug
  // exists (fix specification, not a hint; symptom-vs-cause matters)
  // before reading the format spec / taxonomy / evidence rules.
  // Without it, workers point at the failing line and call it the cause.
  DEBUG_PURPOSE_ORIENTATION,
  '',
  'Use hypothesis-driven debugging. Use this EXACT per-finding format — both the structured reviewer and the deterministic fallback extract from this same format:',
  '',
  '## Finding 1: <one-line title>',
  '- Severity: critical | high | medium | low',
  '- Reproduction: command/input/state to trigger the failure',
  '- Symptom: file:line where the failure surfaces',
  '- Trace: each step file:line + observed value, ending at the cause',
  '- Cause: file:line that, if changed, would prevent the failure',
  '- Fix: proposed change (PROPOSE only — do NOT apply the fix)',
  '- Falsifier: how the maintainer verifies the fix works',
  '',
  '## Finding 2: <one-line title>',
  '- Severity: ...',
  '- ...',
  '',
  'Rules:',
  '- Each finding heading MUST start with "## Finding N: " (h2, "Finding ", number, colon, title) — number sequentially from 1.',
  '- Reproduction / Symptom / Trace / Cause / Fix / Falsifier bullets are on their own lines with the labels exactly as shown.',
  '- This is a read-only diagnostic — do NOT edit any file. Propose fixes; the caller applies them.',
  '- Limit yourself to 3-5 most-likely hypotheses. Do not enumerate implausible ones to pad the list.',
  '',
  // Tool sweep #12: shared rubric so worker self-aligns with the annotator.
  SEVERITY_LADDER,
  '',
  // Debug failure-mode taxonomy. Without this block, workers stop at
  // the first plausible explanation (often the symptom) instead of
  // tracing upstream to the actual cause.
  DEBUG_FAILURE_MODES,
  '',
  // Counter-balances the SEVERITY_LADDER's anti-inflation hint and
  // includes the symptom→cause walk with worked example.
  THOROUGHNESS_REMINDER_DEBUG,
  '',
  EVIDENCE_RULE_DEBUG,
  '',
  SCOPE_RULE_DEBUG,
  '',
  ANNOTATOR_AWARENESS_DEBUG,
].join('\n');

function buildFilePathsPrompt(filePaths?: string[]): string {
  if (!filePaths || filePaths.length === 0) return '';
  return `Read and analyze these files:\n${filePaths.map(p => `- ${p}`).join('\n')}`;
}

export const toolConfig: ToolConfig<Input, ToolDebugBrief, unknown> = {
  name: 'debug',
  category: 'read_only',
  agentType: 'complex',
  briefSlot: debugBriefSlot,
  buildTaskSpec: (brief, ctx) => {
    const parts: string[] = [`Debug this problem:\n\n${brief.problem}`];
    if (brief.context) parts.push(`Context: ${brief.context}`);
    if (brief.hypothesis) parts.push(`Initial hypothesis: ${brief.hypothesis}`);
    const fileSection = buildFilePathsPrompt(brief.filePaths);
    if (fileSection) parts.push(fileSection);
    parts.push(FINDING_FORMAT_INSTRUCTIONS);
    const prompt = parts.join('\n\n');

    const targetParts: string[] = [`Problem to debug:\n\n${brief.problem}`];
    if (brief.context) targetParts.push(`Context: ${brief.context}`);
    if (brief.hypothesis) targetParts.push(`Initial hypothesis: ${brief.hypothesis}`);
    return {
      prompt,
      // Pure user problem statement for the parallel-criteria dispatcher's
      // cached prefix; bypasses the legacy ## Finding format spec from
      // FINDING_FORMAT_INSTRUCTIONS that's already embedded in `prompt`.
      parallelTarget: targetParts.join('\n\n'),
      agentType: 'complex',
      reviewPolicy: 'none',
      briefQualityPolicy: 'off',
      done: 'Identify the root cause with evidence (file, line, mechanism) and PROPOSE a fix. Do NOT apply the fix — debug is a read-only diagnostic; the caller decides whether to apply.',
      tools: ctx.config.defaults?.tools ?? 'full',
      timeoutMs: ctx.config.defaults?.timeoutMs ?? DEFAULT_TASK_TIMEOUT_MS,
      sandboxPolicy: ctx.config.defaults?.sandboxPolicy ?? 'cwd-only',
      cwd: ctx.projectContext?.cwd ?? ctx.cwd,
      contextBlockIds: brief.contextBlockIds,
      autoCommit: false,
      filePaths: brief.filePaths && brief.filePaths.length > 0 ? brief.filePaths : undefined,
      mainModel: ctx.mainModel ?? undefined,
    };
  },
  reportSchema: { parse: (_text) => { throw new Error('no structured report emitted by this executor'); } },
  headlineTemplate: debugHeadlineTemplate,
  reviewTemplates: {
    qualityAP: qualityDebugTemplate,
  },
};
