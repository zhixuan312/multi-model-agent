import type { CriterionEntry } from './criteria-types.js';

/**
 * Per-route semantics for findings. Same wire shape (`## Finding N:`) and
 * same severity tiers (critical / high / medium / low) across all five
 * read-only routes — only the *meaning* of each tier and the per-sub-worker
 * goal differ.
 *
 * Audit / review / debug: each finding = an issue. severity = impact.
 * Verify: each finding = a verification verdict. severity = how decisive
 *   the FAIL signal is (or how strong the PASS evidence is).
 * Investigate: each finding = a candidate answer (or sub-answer) to the
 *   user's question. severity = confidence in the answer.
 */
export interface RouteSemantics {
  /** One-line goal sentence injected at the top of the per-sub-worker
   *  assignment block. e.g. "find issues of THIS specific kind" (audit). */
  goalLine: string;
  /** What "no findings" means for this route, when the sub-worker has
   *  nothing to emit. Investigate's empty case is rare (we can almost
   *  always produce SOME candidate answer, even low-confidence). */
  emptyOutcomeLine: string;
  /** Per-tier severity meaning for THIS route. Replaces the generic
   *  SEVERITY_LADDER inside the cached prefix so the worker calibrates
   *  to the right semantic. Order: critical, high, medium, low. */
  severityMeanings: { critical: string; high: string; medium: string; low: string };
  /** One-paragraph clarifier of what a "finding" represents on this
   *  route. Written into the cached prefix above the format spec so
   *  the worker doesn't default to "find a problem" when the route
   *  semantic is "propose an answer" (investigate) or "report a
   *  verification verdict" (verify). */
  findingMeaningParagraph: string;
  /** Whether each sub-worker MUST emit at least one finding.
   *
   *  - `false` (problem-finding routes — audit/review): "no findings
   *    for this criterion" is a valid honest result; the artifact may
   *    have no problems in the category.
   *  - `true` (answer-finding routes — debug/verify/investigate): the
   *    user asked a question; every parallel angle owes at least one
   *    contribution (even low-severity / low-confidence). The merge
   *    annotator dedups + ranks; soft signals are valuable, not noise.
   */
  mustEmitAtLeastOne: boolean;
}

/**
 * Shared cached-prefix builder for parallel-criteria fan-out across the
 * five read-only routes. The prefix carries everything that's identical
 * across all N sub-workers + the cache-warmer call:
 *   - route-specific orientation, evidence rule, scope rule, annotator awareness
 *   - SEVERITY_LADDER (shared across routes)
 *   - finding-format spec (shared shape: `## Finding N:` blocks)
 *   - the full criterion taxonomy listed by id+title+description so each
 *     sub-worker knows what's NOT theirs
 *   - target content (inlined document and/or file contents pre-read by the
 *     dispatcher)
 *
 * The cache_control marker is attached at the adapter layer; this helper
 * only assembles the text. The per-sub-worker user message (the variable
 * suffix) is built by `buildReadOnlyCriterionSuffix` below.
 *
 * THOROUGHNESS_REMINDER_* / CONFIDENCE_REMINDER_* are intentionally OMITTED.
 * They were calibrated for a single worker covering all categories; with
 * one criterion per worker, that pressure backfires (workers invent weak
 * findings to hit the implied quota when their criterion legitimately has
 * zero matches in the artifact).
 */
export interface CachedPrefixBlocks {
  /** Route-specific orientation, e.g. AUDIT_PURPOSE_ORIENTATION. */
  orientation: string;
  /** Route-specific EVIDENCE_RULE_*. */
  evidenceRule: string;
  /** Route-specific SCOPE_RULE_*. */
  scopeRule: string;
  /** Route-specific ANNOTATOR_AWARENESS_*. */
  annotatorAwareness: string;
  /** Per-route finding format text. */
  findingFormat: string;
  /** The full criterion taxonomy in structured form. */
  criteria: readonly CriterionEntry[];
  /** Route-specific semantics for what a finding represents and what
   *  each severity tier means. */
  semantics: RouteSemantics;
}

function renderSeverityLadder(meanings: RouteSemantics['severityMeanings']): string {
  return [
    'Severity (your judgment, calibrated to the meanings below):',
    `- critical: ${meanings.critical}`,
    `- high:     ${meanings.high}`,
    `- medium:   ${meanings.medium}`,
    `- low:      ${meanings.low}`,
    'Use the FULL ladder. Calibrate to actual signal strength, not how alarming or assertive the wording sounds.',
  ].join('\n');
}

export interface CachedPrefixTarget {
  /** Inlined document content, when present (audit). */
  document?: string;
  /** Map of file path → file contents pre-read by the dispatcher. */
  preReadFiles?: Record<string, string>;
  /** File paths declared by the request, even when their contents weren't
   *  pre-read (sub-worker may grep on demand). */
  filePaths?: readonly string[];
}

export function buildReadOnlyCachedPrefix(
  blocks: CachedPrefixBlocks,
  target: CachedPrefixTarget,
): string {
  const parts: string[] = [
    blocks.orientation,
    '',
    'What a "finding" means on this route:',
    blocks.semantics.findingMeaningParagraph,
    '',
    blocks.findingFormat,
    '',
    renderSeverityLadder(blocks.semantics.severityMeanings),
    '',
    blocks.evidenceRule,
    '',
    blocks.scopeRule,
    '',
    blocks.annotatorAwareness,
    '',
    'Reference taxonomy (other parallel sub-workers cover the categories not assigned to you):',
    ...blocks.criteria.map(c => `- Criterion ${c.id} — ${c.title}: ${c.description}`),
  ];

  if (target.document && target.document.trim().length > 0) {
    parts.push('', 'Target document (inlined):', '', target.document);
  }

  const filePaths = target.filePaths ?? [];
  const preRead = target.preReadFiles ?? {};
  if (filePaths.length > 0) {
    parts.push('', 'Target files (pre-read where contents are below; otherwise the sub-worker may read on demand):');
    for (const fp of filePaths) {
      const content = preRead[fp];
      if (content !== undefined) {
        parts.push('', `--- ${fp} ---`, content);
      } else {
        parts.push('', `--- ${fp} ---`, '(not pre-read; read with read_file if you need its contents)');
      }
    }
  }

  return parts.join('\n');
}

/** Per-sub-worker user message: assigns ONE criterion. The semantics
 *  arg controls how the assignment is framed (find issues / answer
 *  question / verify criterion / find root cause / find quality issues
 *  in the prose).
 *
 *  Same shape across all routes; only `goalLine` and `emptyOutcomeLine`
 *  differ per route. */
export function buildReadOnlyCriterionSuffix(
  semantics: RouteSemantics,
  criterion: CriterionEntry,
): string {
  const minimumBlock = semantics.mustEmitAtLeastOne
    ? [
        'HARD REQUIREMENT (this is non-negotiable):',
        'Your response MUST contain at least one `## Finding N:` block. Empty / "no findings" / narrative-only / commentary-only responses are WORKFLOW ERRORS and will be discarded by the merge annotator.',
        '',
        'If you genuinely cannot construct a finding from this angle, you must STILL emit one finding with severity=low and Issue="Best partial contribution from this angle: <state what you DO know, even if uncertain>". Silence is never the right output — the merge annotator dedups and ranks; a low-confidence partial is far more valuable than nothing.',
      ].join('\n')
    : semantics.emptyOutcomeLine;
  return [
    `Your assignment: criterion ${criterion.id} — "${criterion.title}".`,
    '',
    criterion.description,
    '',
    semantics.goalLine,
    '',
    minimumBlock,
    '',
    'Do NOT drift outside this angle; other parallel sub-workers cover the other angles.',
  ].join('\n');
}
