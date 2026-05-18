import { ToolSurfaceRegistry } from '../../tool-surface/tool-surface-registry.js';
import { inputSchema, type Input } from './schema.js';
import { auditBriefSlot, type AuditBrief } from './brief-slot.js';
import { qualityAuditTemplate } from '../../review/templates/quality-review-audit.js';
import { auditReportSchema, type AuditReport } from '../../reporting/report-parser-slots/audit-report.js';
import { auditHeadlineTemplate } from '../../reporting/headline-templates/audit.js';
import type { ToolConfig } from '../../lifecycle/tool-config-types.js';
import type { TaskSpec } from '../../types.js';
import { DEFAULT_TASK_TIMEOUT_MS } from '../../config/schema.js';
import { SEVERITY_LADDER } from '../../review/templates/finding-criteria.js';
import {
  AUDIT_PURPOSE_ORIENTATION,
  EVIDENCE_RULE_AUDIT,
  SCOPE_RULE_AUDIT,
  ANNOTATOR_AWARENESS_AUDIT,
  DOC_AUDIT_FAILURE_MODES,
  THOROUGHNESS_REMINDER_AUDIT,
} from './implementer-criteria.js';

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

const FINDING_FORMAT_INSTRUCTIONS = [
  // Orientation goes FIRST — the worker needs to know why this audit
  // exists before reading the format spec / taxonomy / evidence rules.
  // Without it, workers calibrated on "find issues in this doc" produce
  // stylistic proofreading; with it, they target executability blockers.
  AUDIT_PURPOSE_ORIENTATION,
  '',
  'Produce a narrative audit report. Use this EXACT per-finding format — both the structured reviewer and the deterministic fallback extract from this same format:',
  '',
  '## Finding 1: <one-line title>',
  '- Severity: critical | high | medium | low',
  '- Location: file:line (when applicable)',
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
  // Tool sweep #12: share the annotator's rubric with the implementer
  // so the worker self-aligns with what the reviewer will check.
  // Result: fewer downgraded findings, fewer missed criticals.
  SEVERITY_LADDER,
  '',
  // Doc-audit failure-mode taxonomy. Without this block, workers calibrated
  // on code-audit rubrics produce only surface-level proofreading nits on
  // prose artifacts. The 11 categories below are what actually goes wrong
  // in non-trivial specs/plans/recommendation docs.
  DOC_AUDIT_FAILURE_MODES,
  '',
  // Counter-balances the SEVERITY_LADDER's anti-inflation hint for the
  // prose-document case, where the typical failure is under-finding.
  THOROUGHNESS_REMINDER_AUDIT,
  '',
  EVIDENCE_RULE_AUDIT,
  '',
  SCOPE_RULE_AUDIT,
  '',
  ANNOTATOR_AWARENESS_AUDIT,
].join('\n');

const DELTA_AUDIT_INSTRUCTIONS = [
  'A prior audit report is provided in the context above. Verify which prior findings have been fixed.',
  'In your output: **omit** fixed findings; **include** still-present findings (mark "unfixed from prior audit"); **include** new findings; end with a **Fixed** summary line.',
].join('\n');

function buildFilePathsPrompt(filePaths: string[]): string {
  if (filePaths.length === 0) return '';
  return `Read and analyze these files:\n${filePaths.map(p => `- ${p}`).join('\n')}`;
}

function buildPrompt(brief: AuditBrief): string {
  const parts: string[] = [`Audit for ${brief.subtypeText} issues.`];

  if (brief.perFilePath) {
    parts.push(`Read and analyze this file:\n- ${brief.perFilePath}`);
  } else {
    if (brief.document) parts.push(`Document:\n\n${brief.document}`);
    const fileSection = buildFilePathsPrompt(brief.filePaths);
    if (fileSection) parts.push(fileSection);
  }

  // Tool sweep #11: emit FINDING_FORMAT_INSTRUCTIONS unconditionally
  // (pre-fix the DELTA branch dropped them, leaving the worker without
  // a format spec → annotator could not parse delta-mode output).
  if (brief.hasContextBlocks) {
    parts.push(DELTA_AUDIT_INSTRUCTIONS);
  }
  parts.push(FINDING_FORMAT_INSTRUCTIONS);

  return parts.join('\n\n');
}

export const toolConfig: ToolConfig<Input, AuditBrief, AuditReport> = {
  name: 'audit',
  category: 'read_only',
  agentType: 'complex',
  briefSlot: auditBriefSlot,
  buildTaskSpec: (brief, ctx) => {
    // For the parallel-criteria dispatcher's cached prefix, hand it the
    // pure document/file targets — not buildPrompt's full spec which
    // embeds the legacy ## Finding format and would compete with the
    // dispatcher's own format spec.
    const targetParts: string[] = [`Audit for ${brief.subtypeText} issues.`];
    if (brief.document) targetParts.push(`Document:\n\n${brief.document}`);
    if (brief.filePaths.length > 0) {
      targetParts.push(`Target files:\n${brief.filePaths.map(p => `- ${p}`).join('\n')}`);
    }
    return {
      prompt: buildPrompt(brief),
      parallelTarget: targetParts.join('\n\n'),
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
  reportSchema: auditReportSchema,
  headlineTemplate: auditHeadlineTemplate,
  reviewTemplates: {
    qualityAP: qualityAuditTemplate,
  },
};
