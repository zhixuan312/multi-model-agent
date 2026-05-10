import type { CriterionEntry } from './criteria-types.js';
import { SEVERITY_LADDER } from '../review/templates/finding-criteria.js';

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
  /** Per-route finding format text. Most routes share the `## Finding N:`
   *  shape; investigate's is slightly different — pass the appropriate
   *  block from the route's tool-config.ts. */
  findingFormat: string;
  /** The full criterion taxonomy in structured form. */
  criteria: readonly CriterionEntry[];
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
    blocks.findingFormat,
    '',
    SEVERITY_LADDER,
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

/** Per-sub-worker user message: assigns ONE criterion and forbids drift
 *  to other categories. Identical structure across the five read-only
 *  routes — the `criterion` arg is the only thing that varies per call. */
export function buildReadOnlyCriterionSuffix(criterion: CriterionEntry): string {
  return [
    `Your assignment: criterion ${criterion.id} — "${criterion.title}".`,
    '',
    criterion.description,
    '',
    'Find ALL issues of THIS specific kind in the artifact above. If none exist, respond with the literal text "No findings for this criterion." — that is a fully valid outcome. Do NOT pad with low-signal observations to avoid returning empty.',
    '',
    'Do NOT report findings outside this criterion; other parallel sub-workers cover the other categories.',
  ].join('\n');
}
