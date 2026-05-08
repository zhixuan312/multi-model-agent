import { ToolSurfaceRegistry } from '../../tool-surface/tool-surface-registry.js';
import { inputSchema, type Input } from './schema.js';
import { qualityAuditTemplate } from '../../review/templates/quality-review-audit.js';
import { auditReportSchema, type AuditReport } from '../../reporting/report-parser-slots/audit-report.js';
import { auditHeadlineTemplate } from '../../reporting/headline-templates/audit.js';
import type { ToolConfig } from '../../lifecycle/tool-config-types.js';
import type { TaskSpec } from '../../types.js';
import { DEFAULT_TASK_TIMEOUT_MS } from '../../config/schema.js';
import { SEVERITY_LADDER } from '../../review/templates/finding-criteria.js';
import {
  EVIDENCE_RULE_AUDIT,
  SCOPE_RULE_AUDIT,
  ANNOTATOR_AWARENESS_AUDIT,
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

// ── Audit brief ──

export interface ToolAuditBrief {
  auditTypeText: string;
  done: string;
  document?: string;
  filePaths: string[];
  hasContextBlocks: boolean;
  contextBlockIds?: string[];
  perFilePath?: string;
}

const AUDIT_DONE_CONDITIONS: Record<string, string> = {
  security: 'Identify all security vulnerabilities (injection, auth bypass, data exposure, OWASP top 10). Each finding has severity (critical/high/medium/low), location, and remediation.',
  performance: 'Identify all performance issues (O(n²) loops, unnecessary allocations, missing caching, blocking I/O). Each finding has impact level, location, and fix recommendation.',
  correctness: 'Identify all logic errors, off-by-one bugs, unhandled edge cases, type mismatches, and contract violations. Each finding has severity, location, and correct behavior.',
  style: 'Identify all style issues (naming, formatting, dead code, inconsistent patterns). Each finding has location and recommended fix.',
  general: 'Identify issues across security, performance, correctness, and style. Each finding has category, severity, location, and remediation.',
};

const DELTA_AUDIT_SUFFIX = ' Perform a full audit (do not reduce thoroughness). Verify each prior finding as fixed or unfixed. Omit fixed prior findings from the main report. Include unfixed prior findings and new findings. End with a summary of which prior findings were resolved.';

function resolveAuditTypeText(auditType: Input['auditType']): string {
  if (auditType === 'general') return 'security, performance, correctness, and style';
  if (Array.isArray(auditType)) return auditType.join(', ');
  return auditType;
}

function resolveDoneCondition(auditType: Input['auditType'], hasContextBlocks: boolean): string {
  let base: string;
  if (auditType === 'general') {
    base = AUDIT_DONE_CONDITIONS.general;
  } else if (Array.isArray(auditType)) {
    base = auditType.map(t => AUDIT_DONE_CONDITIONS[t]).join(' ');
  } else {
    base = AUDIT_DONE_CONDITIONS[auditType] ?? AUDIT_DONE_CONDITIONS.general;
  }
  return hasContextBlocks ? base + DELTA_AUDIT_SUFFIX : base;
}

function hasContent(value: string | undefined): boolean {
  return value !== undefined && value.trim().length > 0;
}

export function auditBriefSlot(input: Input): ToolAuditBrief[] {
  const hasContextBlocks = Array.isArray(input.contextBlockIds) && input.contextBlockIds.length > 0;
  const auditTypeText = resolveAuditTypeText(input.auditType);
  const done = resolveDoneCondition(input.auditType, hasContextBlocks);
  const validPaths = (input.filePaths ?? []).filter(p => p.trim().length > 0);

  // Fan-out: multiple file paths without an inline document
  if (!hasContent(input.document) && validPaths.length >= 2) {
    return validPaths.map(fp => ({
      auditTypeText,
      done,
      filePaths: [fp],
      hasContextBlocks,
      contextBlockIds: input.contextBlockIds,
      perFilePath: fp,
    }));
  }

  return [{
    auditTypeText,
    done,
    document: input.document,
    filePaths: validPaths,
    hasContextBlocks,
    contextBlockIds: input.contextBlockIds,
  }];
}

const FINDING_FORMAT_INSTRUCTIONS = [
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

function buildPrompt(brief: ToolAuditBrief): string {
  const parts: string[] = [`Audit for ${brief.auditTypeText} issues.`];

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

export const toolConfig: ToolConfig<Input, ToolAuditBrief, AuditReport> = {
  name: 'audit',
  category: 'read_only',
  agentType: 'complex',
  briefSlot: auditBriefSlot,
  buildTaskSpec: (brief, ctx) => ({
    prompt: buildPrompt(brief),
    agentType: 'complex',
    reviewPolicy: 'quality_only',
    briefQualityPolicy: 'off',
    done: brief.done,
    tools: ctx.config.defaults?.tools ?? 'full',
    timeoutMs: ctx.config.defaults?.timeoutMs ?? DEFAULT_TASK_TIMEOUT_MS,
    maxCostUSD: ctx.config.defaults?.maxCostUSD ?? 10,
    sandboxPolicy: ctx.config.defaults?.sandboxPolicy ?? 'cwd-only',
    cwd: ctx.projectContext?.cwd ?? ctx.cwd,
    contextBlockIds: brief.contextBlockIds,
    filePaths: brief.filePaths.length > 0 ? brief.filePaths : undefined,
    mainModel: ctx.mainModel,
  } as TaskSpec),
  reportSchema: auditReportSchema,
  headlineTemplate: auditHeadlineTemplate,
  reviewTemplates: {
    qualityAP: qualityAuditTemplate,
  },
};
