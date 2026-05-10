import type { CriterionEntry } from '../tools/criteria-types.js';
import {
  buildReadOnlyCachedPrefix,
  buildReadOnlyCriterionSuffix,
  type CachedPrefixTarget,
  type CachedPrefixBlocks,
} from '../tools/parallel-criteria-prompt.js';
import {
  AUDIT_PURPOSE_ORIENTATION, EVIDENCE_RULE_AUDIT, SCOPE_RULE_AUDIT, ANNOTATOR_AWARENESS_AUDIT, AUDIT_CRITERIA,
} from '../tools/audit/implementer-criteria.js';
import {
  REVIEW_PURPOSE_ORIENTATION, EVIDENCE_RULE_REVIEW, SCOPE_RULE_REVIEW, ANNOTATOR_AWARENESS_REVIEW, REVIEW_CRITERIA,
} from '../tools/review/implementer-criteria.js';
import {
  VERIFY_PURPOSE_ORIENTATION, EVIDENCE_RULE_VERIFY, SCOPE_RULE_VERIFY, ANNOTATOR_AWARENESS_VERIFY, VERIFY_CRITERIA,
} from '../tools/verify/implementer-criteria.js';
import {
  DEBUG_PURPOSE_ORIENTATION, EVIDENCE_RULE_DEBUG, SCOPE_RULE_DEBUG, ANNOTATOR_AWARENESS_DEBUG, DEBUG_CRITERIA,
} from '../tools/debug/implementer-criteria.js';
import {
  INVESTIGATE_PURPOSE_ORIENTATION, EVIDENCE_RULE_INVESTIGATE, SCOPE_RULE_INVESTIGATE, ANNOTATOR_AWARENESS_INVESTIGATE, INVESTIGATE_CRITERIA,
} from '../tools/investigate/implementer-criteria.js';

export type ReadOnlyRouteName = 'audit' | 'review' | 'verify' | 'debug' | 'investigate';

/** Standard finding-format spec used by audit / review / verify / debug
 *  sub-workers. Investigate uses the same shape; downstream consumers
 *  parse `## Finding N:` blocks uniformly. */
const FINDING_FORMAT_SHARED = [
  'Per-finding output format (use exactly this shape — `## Finding N:` blocks):',
  '',
  '## Finding 1: <one-line title>',
  '- Severity: critical | high | medium | low',
  '- Location: file:line (when applicable)',
  '- Issue: one-paragraph explanation',
  '- Suggestion: one-line fix recommendation',
  '',
  '## Finding 2: ... (one block per finding)',
  '',
  'If you found no issues for your assigned criterion, respond with the literal text:',
  '"No findings for this criterion."',
  '',
  'Number findings sequentially starting at 1. Severity / Location / Issue / Suggestion bullets are on their own lines with the labels exactly as shown.',
].join('\n');

const ROUTE_BLOCKS: Record<ReadOnlyRouteName, Omit<CachedPrefixBlocks, 'findingFormat'>> = {
  audit: {
    orientation: AUDIT_PURPOSE_ORIENTATION,
    evidenceRule: EVIDENCE_RULE_AUDIT,
    scopeRule: SCOPE_RULE_AUDIT,
    annotatorAwareness: ANNOTATOR_AWARENESS_AUDIT,
    criteria: AUDIT_CRITERIA,
  },
  review: {
    orientation: REVIEW_PURPOSE_ORIENTATION,
    evidenceRule: EVIDENCE_RULE_REVIEW,
    scopeRule: SCOPE_RULE_REVIEW,
    annotatorAwareness: ANNOTATOR_AWARENESS_REVIEW,
    criteria: REVIEW_CRITERIA,
  },
  verify: {
    orientation: VERIFY_PURPOSE_ORIENTATION,
    evidenceRule: EVIDENCE_RULE_VERIFY,
    scopeRule: SCOPE_RULE_VERIFY,
    annotatorAwareness: ANNOTATOR_AWARENESS_VERIFY,
    criteria: VERIFY_CRITERIA,
  },
  debug: {
    orientation: DEBUG_PURPOSE_ORIENTATION,
    evidenceRule: EVIDENCE_RULE_DEBUG,
    scopeRule: SCOPE_RULE_DEBUG,
    annotatorAwareness: ANNOTATOR_AWARENESS_DEBUG,
    criteria: DEBUG_CRITERIA,
  },
  investigate: {
    orientation: INVESTIGATE_PURPOSE_ORIENTATION,
    evidenceRule: EVIDENCE_RULE_INVESTIGATE,
    scopeRule: SCOPE_RULE_INVESTIGATE,
    annotatorAwareness: ANNOTATOR_AWARENESS_INVESTIGATE,
    criteria: INVESTIGATE_CRITERIA,
  },
};

export interface ReadOnlyRouteSpec {
  criteria: readonly CriterionEntry[];
  buildPrefix: (target: CachedPrefixTarget) => string;
  buildSuffix: (criterion: CriterionEntry) => string;
}

/**
 * Per-route configuration consumed by the parallel-criteria dispatcher.
 * Each entry returns the full builders so the orchestrator can fan out
 * without route-specific branching code.
 */
export const READ_ONLY_ROUTES: Record<ReadOnlyRouteName, ReadOnlyRouteSpec> = Object.fromEntries(
  (['audit', 'review', 'verify', 'debug', 'investigate'] as const).map((route) => {
    const blocks = { ...ROUTE_BLOCKS[route], findingFormat: FINDING_FORMAT_SHARED };
    return [route, {
      criteria: ROUTE_BLOCKS[route].criteria,
      buildPrefix: (target: CachedPrefixTarget) => buildReadOnlyCachedPrefix(blocks, target),
      buildSuffix: buildReadOnlyCriterionSuffix,
    }];
  }),
) as Record<ReadOnlyRouteName, ReadOnlyRouteSpec>;

export function isReadOnlyRoute(route: string): route is ReadOnlyRouteName {
  return route in READ_ONLY_ROUTES;
}
