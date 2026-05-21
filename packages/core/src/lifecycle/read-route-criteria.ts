import type { CriterionEntry } from '../tools/criteria-types.js';
import {
  buildReadOnlyCachedPrefix,
  buildReadOnlyCriterionSuffix,
  type CachedPrefixTarget,
  type CachedPrefixBlocks,
} from '../tools/read-route-prompt.js';
import type { ReadOnlySubtypeSpec } from './read-only-subtype-spec.js';
import { AUDIT_SUBTYPES, type AuditSubtype } from '../tools/audit/subtypes.js';
import { REVIEW_SUBTYPES, type ReviewSubtype } from '../tools/review/subtypes.js';
import { DEBUG_SUBTYPES, type DebugSubtype } from '../tools/debug/subtypes.js';
import { INVESTIGATE_SUBTYPES, type InvestigateSubtype } from '../tools/investigate/subtypes.js';
import { RESEARCH_SUBTYPES, type ResearchSubtype } from '../tools/research/subtypes.js';

export type ReadOnlyRouteName = 'audit' | 'review' | 'debug' | 'investigate' | 'research';

/** Standard finding-format spec — uniform `## Finding N:` shape across
 *  all read-only routes so the downstream parser/annotator only reads
 *  one format. */
export const FINDING_FORMAT_SHARED = [
  'Per-finding output format (use exactly this shape — `## Finding N:` blocks):',
  '',
  '## Finding N: <one-line title>',
  '- Severity: critical | high | medium | low',
  '- Category: <category of issue or focus area>',
  '- Evidence: <one-paragraph explanation (the issue OR the candidate-answer OR the verification verdict OR the root-cause hypothesis, per this route\'s "what a finding means")>',
  '- Suggestion: <one-line follow-up (a fix / how to verify / where to look next)>',
  '',
  '## Finding N+1: ... (one block per finding)',
  '',
  'Number findings sequentially starting at 1. Severity / Category / Evidence / Suggestion bullets are on their own lines with the labels exactly as shown.',
  '',
  'For the investigate route, the Evidence field should include specific file:line references when pointing to code or documentation.',
  '',
  '## Outcome',
  'found: at least one finding was reported',
  'clean: no findings (artifact is satisfactory for this criterion)',
  'not_applicable: this criterion does not apply to the target artifact',
].join('\n');

interface RouteEntry {
  subtypeMap: Record<string, ReadOnlySubtypeSpec>;
  defaultSubtype: string;
}

export const READ_ONLY_ROUTES: Record<ReadOnlyRouteName, RouteEntry> = {
  audit:       { subtypeMap: AUDIT_SUBTYPES       as Record<string, ReadOnlySubtypeSpec>, defaultSubtype: 'default' },
  review:      { subtypeMap: REVIEW_SUBTYPES      as Record<string, ReadOnlySubtypeSpec>, defaultSubtype: 'default' },
  debug:       { subtypeMap: DEBUG_SUBTYPES       as Record<string, ReadOnlySubtypeSpec>, defaultSubtype: 'default' },
  investigate: { subtypeMap: INVESTIGATE_SUBTYPES as Record<string, ReadOnlySubtypeSpec>, defaultSubtype: 'default' },
  research:    { subtypeMap: RESEARCH_SUBTYPES    as Record<string, ReadOnlySubtypeSpec>, defaultSubtype: 'default' },
};

/** Per-subtype builders consumed by the read-route implementer. */
export interface ResolvedRouteSpec {
  criteria: readonly CriterionEntry[];
  buildPrefix: (target: CachedPrefixTarget) => string;
  buildSuffix: (criterion: CriterionEntry) => string;
  semantics: ReadOnlySubtypeSpec['semantics'];
}

/**
 * Resolve a (route, subtype) pair to a concrete spec the implementer can
 * dispatch with. Throws `invalid_subtype` if the subtype is not in the
 * tool's SUBTYPES map. Zod intake should already have caught that; the
 * dispatch-time throw is the defensive backstop.
 */
export function resolveSubtypeSpec(
  route: ReadOnlyRouteName,
  subtype: string | undefined,
): ResolvedRouteSpec {
  const entry = READ_ONLY_ROUTES[route];
  const key = subtype ?? entry.defaultSubtype;
  const spec = entry.subtypeMap[key];
  if (!spec) {
    throw new Error(`invalid_subtype: '${key}' not in ${route}.SUBTYPES (valid: ${Object.keys(entry.subtypeMap).join(', ')})`);
  }
  const blocks: CachedPrefixBlocks = {
    orientation: spec.orientation,
    evidenceRule: spec.evidenceRule,
    scopeRule: spec.scopeRule,
    annotatorAwareness: spec.annotatorAwareness,
    criteria: spec.criteria,
    findingFormat: FINDING_FORMAT_SHARED,
    semantics: spec.semantics,
  };
  return {
    criteria: spec.criteria,
    buildPrefix: (target: CachedPrefixTarget) => buildReadOnlyCachedPrefix(blocks, target),
    buildSuffix: (criterion: CriterionEntry) => buildReadOnlyCriterionSuffix(spec.semantics, criterion),
    semantics: spec.semantics,
  };
}

export function isReadOnlyRoute(route: string): route is ReadOnlyRouteName {
  return route in READ_ONLY_ROUTES;
}

// Re-export per-tool subtype types for callers that need the literal union.
export type { AuditSubtype, ReviewSubtype, DebugSubtype, InvestigateSubtype, ResearchSubtype };
