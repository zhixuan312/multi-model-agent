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

// ── Audit brief ──

export interface ToolAuditBrief {
  subtypeText: string;
  done: string;
  document?: string;
  filePaths: string[];
  hasContextBlocks: boolean;
  contextBlockIds?: string[];
  perFilePath?: string;
  /** v4.4.x: subtype is stamped onto the TaskSpec for the parallel-criteria
   *  dispatcher to read. */
  subtype?: 'default' | 'plan' | 'spec' | 'skill';
}

/**
 * Per-subtype "done" conditions.
 *
 * The audit tool's primary target is prose artifacts: specs, plans,
 * recommendation docs, design docs, briefs, API contracts, configs.
 * `default` is the comprehensive prose sweep. `plan` audits a code-execution
 * plan against the codebase. `spec` audits requirement-style prose for
 * executability. `skill` audits an mma-* skill markdown file for reader
 * effectiveness. For security or performance focus, include that emphasis
 * in the free-text prompt; it is not a subtype.
 */
const AUDIT_DONE_CONDITIONS: Record<string, string> = {
  default:
    'Comprehensive audit. Apply the full failure-mode taxonomy through the executability lens (the orientation block above). For prose artifacts (specs, plans, recommendation docs, designs, post-mortems, audits, briefs): emphasize RECOMMENDATION-COHERENCE, INTERNAL CONTRADICTION, ARGUMENT SOUNDNESS, COMPLETENESS AGAINST CONSTRAINTS, FIX ACTIONABILITY, DRIFT, and SCOPE-CREEP — i.e., would a literal-following worker who reads this artifact and follows it without judgment produce the right outcome? Are sections internally consistent? Does each recommendation actually solve its stated problem given the doc\'s own constraints? Sweep style/clarity issues only when they would cause a worker to misinterpret. For source code: logic errors, contract violations, off-by-one bugs, type mismatches, unhandled edge cases. Each finding has severity (critical/high/medium/low), location, and remediation.',
  plan:
    'PLAN-VS-CODEBASE EXECUTABILITY AUDIT. The single filePath you receive is a code-execution plan; the source files you verify against live under cwd and you discover them yourself by reading the plan\'s "Files: Modify:" / "Test:" / "Create:" blocks and `import` statements in code blocks. Apply the 8 verification perspectives (PATH EXISTENCE, SYMBOL EXISTENCE, SIGNATURE MATCH, IMPORT GRAPH, TEST HARNESS AVAILABILITY, STEP SEQUENCE WITHIN TASK, CROSS-TASK DEPENDENCIES, VERIFICATION COMMAND VALIDITY). For each task in the plan, the merge annotator computes a verdict: EXECUTABLE / PARTIAL / BLOCKED. Use read_file / grep / glob / list_files to ground every finding in real file:line evidence. Findings without source-side citations are speculation — drop them. Zero findings on a perspective is the EXPECTED outcome on a clean plan; do not invent findings to fill quota.',
  spec:
    'REQUIREMENT-PROSE EXECUTABILITY AUDIT. A finding is a place where the spec, executed literally by a downstream worker, would produce the wrong outcome or paralyze the executor. Apply the 7 criteria (REQUIREMENT-TESTABILITY, SCOPE-EXPLICITNESS, ACCEPTANCE-CRITERIA-COVERAGE, NON-FUNCTIONAL-CAPTURED, REQUIREMENT-CONFLICT, DECISION-TRACE, ASSUMPTION-EXPOSURE). Quote the exact `shall` / `must` / `should` clause for each finding. A clean spec legitimately produces zero findings — do not invent issues to fill quota.',
  skill:
    'SKILL-FILE READER-EFFECTIVENESS AUDIT. A finding is a place where the skill, as written, would cause a competent reader to dispatch the wrong call, miss a path of use, or fall for a foreseeable anti-pattern. Apply the 7 criteria (WHEN-TO-USE-SPECIFICITY, INPUT-SHAPE-COMPLETENESS, OUTPUT-SHAPE-CONTRACT, ANTI-PATTERN-COVERAGE, RECIPE-VS-SKILL-SCOPE, VERSION-FRONTMATTER, LINK-INTEGRITY). Quote the failing section + line for each finding.',
};

const DELTA_AUDIT_SUFFIX = ' Perform a full audit (do not reduce thoroughness). Verify each prior finding as fixed or unfixed. Omit fixed prior findings from the main report. Include unfixed prior findings and new findings. End with a summary of which prior findings were resolved.';

function resolveSubtypeText(subtype: Input['subtype'] | undefined): string {
  // Defensive: at the HTTP layer Zod's `.default('default')` fires, but
  // internal callers may still construct Input directly without going
  // through the schema. Treat undefined as the same as `'default'`.
  const t = subtype ?? 'default';
  if (t === 'default') return 'comprehensive prose-coherence';
  if (t === 'plan') return 'plan-vs-codebase';
  if (t === 'spec') return 'requirement-prose executability';
  if (t === 'skill') return 'skill-file reader-effectiveness';
  return `subtype=${t}`;
}

function resolveDoneCondition(subtype: Input['subtype'] | undefined, hasContextBlocks: boolean): string {
  const t = subtype ?? 'default';
  const base = AUDIT_DONE_CONDITIONS[t] ?? AUDIT_DONE_CONDITIONS.default;
  return hasContextBlocks ? base + DELTA_AUDIT_SUFFIX : base;
}

function hasContent(value: string | undefined): boolean {
  return value !== undefined && value.trim().length > 0;
}

export function auditBriefSlot(input: Input): ToolAuditBrief[] {
  const hasContextBlocks = Array.isArray(input.contextBlockIds) && input.contextBlockIds.length > 0;
  const subtypeText = resolveSubtypeText(input.subtype);
  const done = resolveDoneCondition(input.subtype, hasContextBlocks);
  const validPaths = (input.filePaths ?? []).filter(p => p.trim().length > 0);

  // Fan-out: multiple file paths without an inline document
  if (!hasContent(input.document) && validPaths.length >= 2) {
    return validPaths.map(fp => ({
      subtypeText,
      done,
      filePaths: [fp],
      hasContextBlocks,
      contextBlockIds: input.contextBlockIds,
      perFilePath: fp,
      subtype: input.subtype,
    }));
  }

  return [{
    subtypeText,
    done,
    document: input.document,
    filePaths: validPaths,
    hasContextBlocks,
    contextBlockIds: input.contextBlockIds,
    subtype: input.subtype,
  }];
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

function buildPrompt(brief: ToolAuditBrief): string {
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

export const toolConfig: ToolConfig<Input, ToolAuditBrief, AuditReport> = {
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
