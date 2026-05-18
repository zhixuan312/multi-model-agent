import type { Input } from './schema.js';

// ── Audit brief ──

export interface AuditBrief {
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
    'PLAN-VS-CODEBASE EXECUTABILITY AUDIT. The single filePath you receive is a code-execution plan; the source files you verify against live under cwd and you discover them yourself by reading the plan\'s "Files: Modify:" / "Test:" / "Create:" blocks and `import` statements in code blocks. The reference SPEC, when provided, lives as a registered context block in your cached prefix. Apply the 12 verification perspectives in three groups — EXTERNAL CODEBASE COHERENCE (1 PATH EXISTENCE, 2 SYMBOL EXISTENCE, 3 SIGNATURE MATCH, 4 IMPORT GRAPH, 5 TEST HARNESS AVAILABILITY, 6 STEP SEQUENCE WITHIN TASK, 7 CROSS-TASK DEPENDENCIES, 8 VERIFICATION COMMAND VALIDITY), INTRA-PLAN STRUCTURE (9 TASK GRANULARITY, 11 PLACEHOLDER LANGUAGE, 12 PLAN SKELETON), and SPEC ALIGNMENT (10 SPEC COVERAGE). For each task, the merge annotator computes a verdict: EXECUTABLE / PARTIAL / BLOCKED. Use read_file / grep / glob / list_files to ground perspectives 1–8 in real file:line evidence; perspectives 9, 11, 12 are intra-plan and need only a plan-side quote; perspective 10 requires a spec-side clause quote plus a plan-side task reference. If no spec is in context, emit "No findings for this criterion." for perspective 10 ONLY. Zero findings on a perspective is the EXPECTED outcome on a clean plan; do not invent findings to fill quota.',
  spec:
    'REQUIREMENT-PROSE EXECUTABILITY AUDIT. A finding is a place where the spec, executed literally by a downstream worker (the planner that will run writing-plans on it), would produce the wrong outcome or paralyze the executor. Apply the 9 criteria (REQUIREMENT-TESTABILITY, SCOPE-EXPLICITNESS-AND-DECOMPOSABILITY, ACCEPTANCE-CRITERIA-COVERAGE, NON-FUNCTIONAL-CAPTURED, REQUIREMENT-CONFLICT, DECISION-TRACE, ASSUMPTION-EXPOSURE, PLACEHOLDER-SCAN, DESIGN-DECOMPOSITION-PRESENT). Quote the exact `shall` / `must` / `should` clause (or the placeholder / missing-design-dimension reference) for each finding. A clean spec legitimately produces zero findings — do not invent issues to fill quota.',
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

export function auditBriefSlot(input: Input): AuditBrief[] {
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
